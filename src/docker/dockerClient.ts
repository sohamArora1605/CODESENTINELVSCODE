import { exec } from "child_process";
import { promisify } from "util";
import { BackendMode } from "../types";

const execAsync = promisify(exec);

export interface DockerRunOptions {
  workspacePath: string;
  imageName: string;
  args?: string[];
  environment?: Record<string, string>;
  readOnly?: boolean;
  dockerCommand?: string;
  timeoutMs?: number;
}

export class DockerClient {
  private static instance: DockerClient;

  private constructor() {}

  public static getInstance(): DockerClient {
    if (!DockerClient.instance) {
      DockerClient.instance = new DockerClient();
    }
    return DockerClient.instance;
  }

  public async checkDockerAvailability(
    customDockerCmd = "docker"
  ): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execAsync(`"${customDockerCmd}" --version`);
      return { available: true, version: stdout.trim() };
    } catch (err: any) {
      return { available: false, error: err.message || `Docker CLI '${customDockerCmd}' not detected in PATH` };
    }
  }

  public async runContainer(
    options: DockerRunOptions,
    backendMode: BackendMode = "local-docker"
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (backendMode === "cloud") {
      return {
        stdout: "Dispatched to Cloud Cluster endpoint.",
        stderr: "",
        exitCode: 0,
      };
    }

    const dockerExecutable = options.dockerCommand || "docker";
    const mountFlag = options.readOnly !== false ? ":ro" : "";
    const workspaceMount = `"${options.workspacePath}:/workspace${mountFlag}"`;
    const envFlags = options.environment
      ? Object.entries(options.environment)
          .map(([k, v]) => `-e ${k}="${v}"`)
          .join(" ")
      : "";
    const argsStr = options.args ? options.args.join(" ") : "";

    const dockerCmd = `"${dockerExecutable}" run --rm -v ${workspaceMount} -w /workspace ${envFlags} ${options.imageName} ${argsStr}`.trim();

    try {
      const { stdout, stderr } = await execAsync(dockerCmd, {
        timeout: options.timeoutMs || 120000,
        maxBuffer: 20 * 1024 * 1024,
      });

      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      throw new Error(`Docker container run failed: ${err.message}`);
    }
  }

  public async checkImageExists(imageName = "codesentinel/core:latest"): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`docker images -q "${imageName}"`);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async buildBackendImage(
    contextPath: string,
    tag = "codesentinel/core:latest"
  ): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync(`docker build -t "${tag}" .`, {
        cwd: contextPath,
        timeout: 300000,
      });
      return { success: true, output: (stdout + "\n" + stderr).trim() };
    } catch (err: any) {
      return { success: false, output: err.message || "Docker build failed" };
    }
  }

  public getDockerMcpCommand(workspaceRoot: string, imageName = "codesentinel/core:latest"): string[] {
    return [
      "docker",
      "run",
      "-i",
      "--rm",
      "-v",
      `${workspaceRoot}:/workspace:ro`,
      "-e",
      "CODESENTINEL_WORKSPACE=/workspace",
      imageName,
    ];
  }
}
