{
  description = "Tela — AI Agent Platform with pluggable execution backends";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    claude-code-nix.url = "github:sadjow/claude-code-nix";
  };

  outputs = { self, nixpkgs, flake-utils, claude-code-nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        claude-code = claude-code-nix.packages.${system}.default;

        # Agent worker container image built with Nix
        # Reproducible, declarative, no Dockerfile needed
        agentWorkerImage = pkgs.dockerTools.buildLayeredImage {
          name = "tela-agent-worker";
          tag = "latest";

          contents = [
            pkgs.nodejs_22
            pkgs.coreutils
            pkgs.cacert        # TLS certificates for HTTPS
            pkgs.curl          # health checks / debugging
            pkgs.git           # vault git operations
            pkgs.jq            # JSON processing in scripts
            pkgs.bashInteractive
          ];

          config = {
            Cmd = [ "node" "dist/agent-worker.js" ];
            WorkingDir = "/app";
            Env = [
              "NODE_ENV=production"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            Labels = {
              "org.opencontainers.image.title" = "tela-agent-worker";
              "org.opencontainers.image.description" = "Isolated agent execution container for Tela platform";
            };
          };

          # Copy the compiled application into the image
          extraCommands = ''
            mkdir -p app
            # The dist/ and node_modules/ are expected to be pre-built
            # and copied in via the build script (see scripts/build-worker-image.sh)
            echo '{"name":"tela-agent-worker","type":"module"}' > app/package.json
          '';
        };

        # DevContainer image — rich development environment for coding agents
        # Includes full toolchain for building web apps (Node, Python, Go, Rust, etc.)
        devContainerImage = pkgs.dockerTools.buildLayeredImage {
          name = "tela-devcontainer";
          tag = "latest";

          contents = [
            # Core
            pkgs.nodejs_22
            pkgs.coreutils
            pkgs.findutils
            pkgs.gnugrep
            pkgs.gnused
            pkgs.cacert
            pkgs.bashInteractive
            pkgs.gnumake
            # Networking / debugging
            pkgs.curl
            pkgs.wget
            # Version control
            pkgs.git
            pkgs.openssh
            # Search / navigation
            pkgs.ripgrep
            pkgs.tree
            pkgs.jq
            # Node.js tooling
            pkgs.nodePackages.npm
            pkgs.nodePackages.pnpm
            # Python
            pkgs.python312
            pkgs.python312Packages.pip
            pkgs.python312Packages.virtualenv
          ];

          config = {
            Cmd = [ "bash" ];
            WorkingDir = "/workspace";
            Env = [
              "NODE_ENV=development"
              "HOME=/root"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              "PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ];
            ExposedPorts = {
              "3000/tcp" = {};
              "3001/tcp" = {};
              "4000/tcp" = {};
              "5173/tcp" = {};
              "8000/tcp" = {};
              "8080/tcp" = {};
            };
            Volumes = {
              "/workspace" = {};
            };
            Labels = {
              "org.opencontainers.image.title" = "tela-devcontainer";
              "org.opencontainers.image.description" = "Development container for Tela coding agents — full web dev toolchain";
            };
          };

          extraCommands = ''
            mkdir -p workspace root tmp
          '';
        };

        # Build script to prepare and load the devcontainer image
        buildDevContainer = pkgs.writeShellScriptBin "build-devcontainer" ''
          set -euo pipefail
          echo "Building tela-devcontainer image with Nix..."

          IMAGE_PATH=$(nix build .#devContainerImage --no-link --print-out-paths)
          echo "Base image built: $IMAGE_PATH"

          docker load < "$IMAGE_PATH"
          echo "✓ tela-devcontainer:latest ready"
          docker images tela-devcontainer:latest
        '';

        # Build script to prepare and load the image
        buildWorkerImage = pkgs.writeShellScriptBin "build-worker-image" ''
          set -euo pipefail
          echo "Building tela-agent-worker container image with Nix..."

          # Build the base image from Nix
          IMAGE_PATH=$(nix build .#agentWorkerImage --no-link --print-out-paths)
          echo "Base image built: $IMAGE_PATH"

          # Load into Docker
          docker load < "$IMAGE_PATH"
          echo "Image loaded into Docker as tela-agent-worker:latest"

          # Create a temp container to copy in the app code
          CONTAINER_ID=$(docker create tela-agent-worker:latest)

          # Copy compiled code into the container
          docker cp dist/. "$CONTAINER_ID:/app/dist/"
          docker cp node_modules/. "$CONTAINER_ID:/app/node_modules/"

          # Commit the container as the final image
          docker commit "$CONTAINER_ID" tela-agent-worker:latest
          docker rm "$CONTAINER_ID"

          echo "✓ tela-agent-worker:latest ready"
          docker images tela-agent-worker:latest
        '';

      in
      {
        # Development shell
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            claude-code
          ];

          shellHook = ''
            echo "Tela dev shell (Node $(node --version), Claude CLI $(claude --version 2>/dev/null || echo 'n/a'))"
          '';
        };

        # Docker image for agent workers
        packages.agentWorkerImage = agentWorkerImage;

        # Docker image for devcontainer (coding agents)
        packages.devContainerImage = devContainerImage;

        # Helper script to build + load the worker image
        packages.buildWorkerImage = buildWorkerImage;

        # Helper script to build + load the devcontainer image
        packages.buildDevContainer = buildDevContainer;

        # Convenience: `nix run .#build-worker` to build the image
        apps.build-worker = {
          type = "app";
          program = "${buildWorkerImage}/bin/build-worker-image";
        };

        # Convenience: `nix run .#build-devcontainer` to build the devcontainer image
        apps.build-devcontainer = {
          type = "app";
          program = "${buildDevContainer}/bin/build-devcontainer";
        };
      });
}
