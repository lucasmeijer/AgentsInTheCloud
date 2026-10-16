package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "agents-in-the-cloud/workspace-helper/workspacehelperv1"
)

const defaultWorkdir = "/work"

// Only systemd's bookkeeping for the helper's own service; children must not
// inherit it. JOURNAL_STREAM, for example, makes programs log to the journal.
var serviceOnlyEnvironment = map[string]bool{
	"INVOCATION_ID": true, "JOURNAL_STREAM": true, "SYSTEMD_EXEC_PID": true, "NOTIFY_SOCKET": true,
	"MANAGERPID": true, "LISTEN_PID": true, "LISTEN_FDS": true, "LISTEN_FDNAMES": true,
	"MAINPID": true, "RUNTIME_DIRECTORY": true, "CREDENTIALS_DIRECTORY": true,
}

type helper struct {
	pb.UnimplementedWorkspaceHelperServer
	// Account names for each User.
	users map[pb.User]string
	// Only a root helper can run processes as another user.
	switchUser bool
}

type identity struct {
	uid, gid uint32
	groups   []uint32
	name     string
	home     string
}

func (s *helper) lookupUser(requested pb.User) (identity, error) {
	name, ok := s.users[requested]
	if !ok {
		return identity{}, status.Errorf(codes.InvalidArgument, "unknown user %v", requested)
	}
	account, err := user.Lookup(name)
	if err != nil {
		return identity{}, status.Errorf(codes.FailedPrecondition, "look up user %s: %v", name, err)
	}
	uid, err := strconv.ParseUint(account.Uid, 10, 32)
	if err != nil {
		return identity{}, err
	}
	gid, err := strconv.ParseUint(account.Gid, 10, 32)
	if err != nil {
		return identity{}, err
	}
	groupIDs, err := account.GroupIds()
	if err != nil {
		return identity{}, status.Errorf(codes.FailedPrecondition, "look up groups of %s: %v", name, err)
	}
	groups := make([]uint32, 0, len(groupIDs))
	for _, id := range groupIDs {
		group, err := strconv.ParseUint(id, 10, 32)
		if err != nil {
			return identity{}, err
		}
		groups = append(groups, uint32(group))
	}
	return identity{uid: uint32(uid), gid: uint32(gid), groups: groups, name: account.Username, home: account.HomeDir}, nil
}

func environment(account identity, extra map[string]string) []string {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if !serviceOnlyEnvironment[name] {
			values[name] = value
		}
	}
	values["HOME"] = account.home
	values["USER"] = account.name
	values["LOGNAME"] = account.name
	for name, value := range extra {
		values[name] = value
	}
	result := make([]string, 0, len(values))
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result
}

// Resolves argv[0] through the process's own PATH, which may differ from the helper's.
func lookPath(name string, env []string) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	path := ""
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "PATH="); ok {
			path = value
		}
	}
	for _, directory := range filepath.SplitList(path) {
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", status.Errorf(codes.NotFound, "executable %q not found in PATH", name)
}

func validSignal(signal pb.Signal) (syscall.Signal, error) {
	switch signal {
	case pb.Signal_SIGNAL_HUP:
		return syscall.SIGHUP, nil
	case pb.Signal_SIGNAL_INT:
		return syscall.SIGINT, nil
	case pb.Signal_SIGNAL_TERM:
		return syscall.SIGTERM, nil
	case pb.Signal_SIGNAL_KILL:
		return syscall.SIGKILL, nil
	}
	return 0, status.Errorf(codes.InvalidArgument, "unknown signal %v", signal)
}

func startError(err error) error {
	if errors.Is(err, os.ErrPermission) {
		return status.Errorf(codes.PermissionDenied, "start process: %v", err)
	}
	return status.Errorf(codes.FailedPrecondition, "start process: %v", err)
}

// One running process and the ends of its stdio that the helper holds.
type process struct {
	command *exec.Cmd
	// Where `stdin` requests go: a pipe, the PTY, or nil without stdin.
	input *os.File
	// The PTY, which also takes resizes; nil without a terminal.
	terminal *os.File
	stdout   *os.File
	// Nil with a terminal.
	stderr *os.File
}

// Closing a nil or already closed file is harmless.
func (p *process) close() {
	for _, file := range []*os.File{p.input, p.stdout, p.stderr} {
		file.Close()
	}
}

func (p *process) closeStdin() {
	if p.terminal == nil {
		p.input.Close()
	}
}

func (p *process) signal(signal syscall.Signal) error {
	// Setpgid and Setsid both make the process lead its own group.
	return syscall.Kill(-p.command.Process.Pid, signal)
}

func startProcess(start *pb.ExecStart, account identity, switchUser bool) (*process, error) {
	if len(start.Argv) == 0 {
		return nil, status.Error(codes.InvalidArgument, "argv must not be empty")
	}
	workdir := start.Workdir
	if workdir == "" {
		workdir = defaultWorkdir
	}
	if !filepath.IsAbs(workdir) {
		return nil, status.Errorf(codes.InvalidArgument, "workdir must be absolute: %q", workdir)
	}
	if start.Terminal != nil && start.Stdin {
		return nil, status.Error(codes.InvalidArgument, "stdin must be unset with a terminal")
	}
	env := environment(account, start.Env)
	executable, err := lookPath(start.Argv[0], env)
	if err != nil {
		return nil, err
	}
	command := &exec.Cmd{Path: executable, Args: start.Argv, Env: env, Dir: workdir, SysProcAttr: &syscall.SysProcAttr{}}
	if switchUser {
		command.SysProcAttr.Credential = &syscall.Credential{Uid: account.uid, Gid: account.gid, Groups: account.groups}
	}
	if start.Terminal != nil {
		return startTerminalProcess(command, start.Terminal, account, switchUser)
	}
	command.SysProcAttr.Setpgid = true
	result := &process{command: command}
	// Children get the other ends, which the helper closes once they have them.
	var childEnds []*os.File
	defer func() {
		for _, file := range childEnds {
			file.Close()
		}
	}()
	pipe := func() (*os.File, *os.File, error) {
		reader, writer, err := os.Pipe()
		if err != nil {
			result.close()
		}
		return reader, writer, err
	}
	if start.Stdin {
		reader, writer, err := pipe()
		if err != nil {
			return nil, err
		}
		command.Stdin, result.input = reader, writer
		childEnds = append(childEnds, reader)
	}
	stdout, stdoutWriter, err := pipe()
	if err != nil {
		return nil, err
	}
	command.Stdout, result.stdout = stdoutWriter, stdout
	childEnds = append(childEnds, stdoutWriter)
	stderr, stderrWriter, err := pipe()
	if err != nil {
		return nil, err
	}
	command.Stderr, result.stderr = stderrWriter, stderr
	childEnds = append(childEnds, stderrWriter)
	if err := command.Start(); err != nil {
		result.close()
		return nil, startError(err)
	}
	return result, nil
}

func startTerminalProcess(command *exec.Cmd, size *pb.TerminalSize, account identity, switchUser bool) (*process, error) {
	if size.Cols == 0 || size.Rows == 0 {
		return nil, status.Error(codes.InvalidArgument, "terminal size must not be zero")
	}
	terminal, tty, err := pty.Open()
	if err != nil {
		return nil, err
	}
	defer tty.Close()
	// Programs such as tmux reopen their terminal by name, as their own user.
	if switchUser {
		if err := tty.Chown(int(account.uid), int(account.gid)); err != nil {
			terminal.Close()
			return nil, err
		}
	}
	if err := pty.Setsize(terminal, &pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)}); err != nil {
		terminal.Close()
		return nil, err
	}
	command.Stdin, command.Stdout, command.Stderr = tty, tty, tty
	command.SysProcAttr.Setsid = true
	command.SysProcAttr.Setctty = true
	if err := command.Start(); err != nil {
		terminal.Close()
		return nil, startError(err)
	}
	return &process{command: command, input: terminal, terminal: terminal, stdout: terminal}, nil
}

func (s *helper) Exec(stream pb.WorkspaceHelper_ExecServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "the first request must be start")
	}
	account, err := s.lookupUser(start.User)
	if err != nil {
		return err
	}
	running, err := startProcess(start, account, s.switchUser)
	if err != nil {
		return err
	}

	var sending sync.Mutex
	send := func(response *pb.ExecResponse) error {
		sending.Lock()
		defer sending.Unlock()
		return stream.Send(response)
	}

	// The process runs from here on: every path below must reap it.
	exited := make(chan struct{})
	var wait error
	go func() {
		wait = running.command.Wait()
		close(exited)
	}()

	var failure struct {
		sync.Mutex
		err error
	}
	fail := func(err error) {
		failure.Lock()
		if failure.err == nil {
			failure.err = err
		}
		failure.Unlock()
		running.signal(syscall.SIGKILL)
	}

	go s.receive(stream, running, fail)

	var output sync.WaitGroup
	forward := func(file *os.File, wrap func([]byte) *pb.ExecResponse) {
		defer output.Done()
		buffer := make([]byte, 32*1024)
		for {
			n, err := file.Read(buffer)
			if n > 0 {
				if err := send(wrap(append([]byte(nil), buffer[:n]...))); err != nil {
					fail(err)
					return
				}
			}
			if err != nil {
				// A PTY reports EIO once every process has closed it.
				if err != io.EOF && !errors.Is(err, syscall.EIO) && !errors.Is(err, os.ErrClosed) {
					fail(err)
				}
				return
			}
		}
	}
	output.Add(1)
	go forward(running.stdout, func(data []byte) *pb.ExecResponse {
		return &pb.ExecResponse{Response: &pb.ExecResponse_Stdout{Stdout: data}}
	})
	if running.stderr != nil {
		output.Add(1)
		go forward(running.stderr, func(data []byte) *pb.ExecResponse {
			return &pb.ExecResponse{Response: &pb.ExecResponse_Stderr{Stderr: data}}
		})
	}

	drained := make(chan struct{})
	go func() {
		output.Wait()
		close(drained)
	}()
	select {
	case <-drained:
	case <-stream.Context().Done():
		fail(stream.Context().Err())
		// Processes that left the group may still hold the output open.
		running.close()
		<-drained
	}
	<-exited
	running.close()

	failure.Lock()
	err = failure.err
	failure.Unlock()
	if err != nil {
		if _, ok := status.FromError(err); ok {
			return err
		}
		return status.FromContextError(err).Err()
	}
	var exitError *exec.ExitError
	if wait != nil && !errors.As(wait, &exitError) {
		return status.Errorf(codes.Internal, "wait for process: %v", wait)
	}
	result := &pb.Exited{}
	waitStatus := running.command.ProcessState.Sys().(syscall.WaitStatus)
	if waitStatus.Signaled() {
		result.Status = &pb.Exited_Signal{Signal: int32(waitStatus.Signal())}
	} else {
		result.Status = &pb.Exited_ExitCode{ExitCode: int32(waitStatus.ExitStatus())}
	}
	return send(&pb.ExecResponse{Response: &pb.ExecResponse_Exited{Exited: result}})
}

// Applies requests after start until the client closes its side or the call ends.
func (s *helper) receive(stream pb.WorkspaceHelper_ExecServer, running *process, fail func(error)) {
	for {
		request, err := stream.Recv()
		if err == io.EOF {
			running.closeStdin()
			return
		}
		if err != nil {
			// The call ended; Exec notices through the context.
			return
		}
		switch request := request.Request.(type) {
		case *pb.ExecRequest_Stdin:
			if running.input == nil {
				fail(status.Error(codes.FailedPrecondition, "the process has no stdin"))
				return
			}
			if _, err := running.input.Write(request.Stdin); err != nil && !errors.Is(err, syscall.EPIPE) && !errors.Is(err, os.ErrClosed) {
				fail(err)
				return
			}
		case *pb.ExecRequest_CloseStdin:
			if running.terminal != nil {
				fail(status.Error(codes.FailedPrecondition, "close_stdin is not allowed with a terminal"))
				return
			}
			running.closeStdin()
		case *pb.ExecRequest_Signal:
			signal, err := validSignal(request.Signal)
			if err != nil {
				fail(err)
				return
			}
			if err := running.signal(signal); err != nil && !errors.Is(err, syscall.ESRCH) {
				fail(err)
				return
			}
		case *pb.ExecRequest_Resize:
			if running.terminal == nil {
				fail(status.Error(codes.FailedPrecondition, "resize needs a terminal"))
				return
			}
			if err := pty.Setsize(running.terminal, &pty.Winsize{Cols: uint16(request.Resize.Cols), Rows: uint16(request.Resize.Rows)}); err != nil {
				fail(err)
				return
			}
		case *pb.ExecRequest_Start:
			fail(status.Error(codes.InvalidArgument, "start was already sent"))
			return
		default:
			fail(status.Errorf(codes.InvalidArgument, "unknown request %T", request))
			return
		}
	}
}
