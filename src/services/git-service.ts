import { config } from '../config/env.js';

export class GitService {
  private docker: any = null;

  private async getDocker() {
    if (!this.docker) {
      const Dockerode = (await import('dockerode')).default;
      this.docker = new Dockerode();
    }
    return this.docker;
  }

  private async exec(cmd: string[]): Promise<string> {
    const docker = await this.getDocker();
    const container = docker.getContainer(config.gitServerContainerName);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    return new Promise((resolve, reject) => {
      exec.start({ hijack: true, stdin: false }, (err: Error | null, stream: any) => {
        if (err) return reject(err);
        let output = '';
        stream.on('data', (chunk: Buffer) => {
          // Docker multiplexed stream: first 8 bytes are header
          output += chunk.slice(8).toString();
        });
        stream.on('end', () => resolve(output.trim()));
        stream.on('error', reject);
      });
    });
  }

  async initRepo(slug: string): Promise<string> {
    const repoPath = `/repos/${slug}.git`;
    // Init bare repo
    await this.exec(['git', 'init', '--bare', repoPath]);
    // Enable push over HTTP
    await this.exec(['git', '-C', repoPath, 'config', 'http.receivepack', 'true']);
    // Set default branch to main
    await this.exec(['git', '-C', repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    // Fix ownership
    await this.exec(['chown', '-R', 'www-data:www-data', repoPath]);

    // Push an initial commit so the repo is cloneable
    await this.pushInitialCommit(slug);

    return this.internalUrl(slug);
  }

  private async pushInitialCommit(slug: string): Promise<void> {
    const tmpDir = `/tmp/init-${slug}`;
    const cloneUrl = this.internalUrl(slug);

    try {
      await this.exec(['bash', '-c', [
        `git -c user.name="Tela" -c user.email="tela@tela.internal" clone ${cloneUrl} ${tmpDir}`,
        `echo "# ${slug}\n\nCreated by Tela App Builder." > ${tmpDir}/README.md`,
        `git -C ${tmpDir} add README.md`,
        `git -C ${tmpDir} -c user.name="Tela" -c user.email="tela@tela.internal" commit -m "Initial commit"`,
        `git -C ${tmpDir} push origin main`,
        `rm -rf ${tmpDir}`,
      ].join(' && ')]);
    } catch (err) {
      // Initial commit is best-effort — repo is still usable
      console.warn(`[git] Initial commit for ${slug} failed (non-fatal):`, err);
    }
  }

  async deleteRepo(slug: string): Promise<void> {
    await this.exec(['rm', '-rf', `/repos/${slug}.git`]);
  }

  async listRepos(): Promise<string[]> {
    const output = await this.exec(['ls', '/repos']);
    return output.split('\n').filter(Boolean);
  }

  /** URL devcontainers use to clone (host.docker.internal resolves on Mac/Windows/Linux) */
  cloneUrl(slug: string): string {
    return `http://host.docker.internal:${config.gitServerPort}/${slug}.git`;
  }

  /** URL other containers on the Docker network use */
  internalUrl(slug: string): string {
    return `${config.gitServerUrl}/${slug}.git`;
  }
}
