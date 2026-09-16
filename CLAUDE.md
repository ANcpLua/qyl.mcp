# Website locations

- The live website at https://qyl.at is maintained in the separate repository https://github.com/ANcpLua/qyl.at.
- Its homepage source is `src/pages/index.astro`, with shared styling in `src/styles/global.css`. Astro generates the site into `dist/`, and the repository's Cloudflare configuration deploys it to the `qyl.at` custom domain.
- This repository (`ANcpLua/qyl.mcp`) contains a separate MCP landing page. `sites/qyl-mcp.html` is a standalone snapshot of the local MCP landing page preview, including its styles and scripts. It is not a snapshot of the live `qyl.at` homepage.
- For changes to the live `qyl.at` homepage, work in `ANcpLua/qyl.at`. Do not assume changes to `sites/qyl-mcp.html` update that website.
