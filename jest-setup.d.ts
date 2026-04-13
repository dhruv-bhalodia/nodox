// nodox-cli/jest-setup — side-effects only, no exports.
// Injected into Jest/Vitest via `npx nodox init`.
// Patches http.request and https.request to record HTTP exchanges during tests
// and writes observed shapes to .apicache.json on process exit.
export {}
