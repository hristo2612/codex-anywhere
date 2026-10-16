{
  flake-utils,
  nixpkgs,
  ...
}:
let
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    version = "0.158.0-alpha.2";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-K6gGRghwLnQ4UVDga7HY1FxeXjkfMrH4P1p+GPn/EHI=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-lEZkGUzdZc/+8GdWwn9Dbvo/j3j3rYDUaYHt5Wfmna0=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-Kwyjl6ld+JJm0V1czUl/T4PzOkkcpGUYlLAk82yrgEs=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-b1v+7aknSse0UCxAnMZBHUj1t3STpdiL+GuyAPoqZaI=";
        };
      }
      .${system};
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform.npm}.tgz";
      hash = platform.hash;
    };
  in
  {
    packages.codex =
      pkgs.runCommand "codex-${version}"
        {
          pname = "codex";
          inherit src version;
        }
        ''
          tar -xzf "$src"
          install -Dm755 package/vendor/*/bin/codex "$out/bin/codex"
          install -Dm755 package/vendor/*/bin/codex-code-mode-host "$out/bin/codex-code-mode-host"
        '';
  }
)
