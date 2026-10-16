// Runs inside a workspace and serves the app's WorkspaceHelper calls.
package main

import (
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"google.golang.org/grpc"

	pb "agents-in-the-cloud/workspace-helper/workspacehelperv1"
)

func listen(path string) (net.Listener, error) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	// The socket runs anything as root, so only the directory's owner, the app,
	// may connect.
	var directory syscall.Stat_t
	if err := syscall.Stat(filepath.Dir(path), &directory); err != nil {
		listener.Close()
		return nil, err
	}
	if err := os.Chown(path, int(directory.Uid), int(directory.Gid)); err != nil {
		listener.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func main() {
	socket := flag.String("listen", "/run/agents-in-the-cloud-helper/helper.sock", "Unix socket to serve on")
	flag.Parse()
	if os.Geteuid() != 0 {
		log.Fatal("the workspace helper must run as root")
	}
	listener, err := listen(*socket)
	if err != nil {
		log.Fatalf("listen on %s: %v", *socket, err)
	}
	server := grpc.NewServer()
	pb.RegisterWorkspaceHelperServer(server, &helper{
		users:      map[pb.User]string{pb.User_USER_AGENT: "agents-in-the-cloud", pb.User_USER_ROOT: "root"},
		switchUser: true,
	})
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
		<-stop
		// Running calls end, and with them their processes.
		server.Stop()
	}()
	log.Printf("workspace helper listening on %s", *socket)
	if err := server.Serve(listener); err != nil {
		log.Fatal(err)
	}
}
