const caBundleCandidates = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/openshell-tls/ca-bundle.pem",
];

/**
 * Builds the native git clone command used inside Daytona workspaces.
 * Implementations must keep repo URL and path arguments shell-quoted, discover a
 * readable CA bundle before cloning, and must never disable TLS verification.
 */
export function createGitCloneCommand(input: {
  destinationPath: string;
  repoUrl: string;
  resetCommand: string;
}): string {
  return [
    input.resetCommand,
    createCaBundleDiscoveryCommand(),
    `git clone --depth 1 ${shellQuote(input.repoUrl)} ${shellQuote(input.destinationPath)}`,
  ].join(" && ");
}

function createCaBundleDiscoveryCommand(): string {
  return `for makeademo_ca_bundle in ${caBundleCandidates.map(shellQuote).join(" ")}; do if test -f "$makeademo_ca_bundle"; then export GIT_SSL_CAINFO="$makeademo_ca_bundle"; export SSL_CERT_FILE="$makeademo_ca_bundle"; export CURL_CA_BUNDLE="$makeademo_ca_bundle"; break; fi; done`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
