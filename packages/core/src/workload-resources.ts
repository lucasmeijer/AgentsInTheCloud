import { readTextIfExists } from "./fs.ts";
const descriptor = "/run/agents-in-the-cloud-system/resources.json";
async function resources(): Promise<
  { workloadsCgroupParent: string } | undefined
> {
  const text = await readTextIfExists(descriptor);
  return text === undefined ? undefined : JSON.parse(text);
}
export async function workloadCgroupArgs(): Promise<string[]> {
  const config = await resources();
  return config ? ["--cgroup-parent", config.workloadsCgroupParent] : [];
}
export async function workloadCommand(args: string[]): Promise<string[]> {
  if (!(await resources())) return args;
  return [
    "sh",
    "-ec",
    'echo $$ > /run/agents-in-the-cloud-system/workload-processes/cgroup.procs; exec "$@"',
    "agents-in-the-cloud-workload",
    ...args,
  ];
}
