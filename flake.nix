{
  description = "Claude Agent - TypeScript agent using Claude Agent SDK";

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
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            claude-code
          ];

          shellHook = ''
            echo "Claude Agent dev shell (Node $(node --version), Claude CLI $(claude --version 2>/dev/null || echo 'n/a'))"
          '';
        };
      });
}
