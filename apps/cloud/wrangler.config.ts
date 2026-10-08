// cf's Wrangler build/dev backend reads these local tooling settings.
// Resource names, bindings and modes remain in cloudflare.config.ts.
export default {
  dev: {
    ip: "127.0.0.1",
    port: 8788,
    inspectorIp: "127.0.0.1",
    inspectorPort: 9229,
  },
};
