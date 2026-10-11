# qyl Auth0 tenant configuration

`tenant.json` records the existing qyl API, seven named user clients, Events
management client, and denied-by-default third-party grant in `qyl-eu`. It
contains no credentials or user/client identifiers. The mapped owner and reviewer
subjects come from the deployment's `MCP_COLLECTOR_PROJECTS` environment value;
keep that value in Vitals/Railway and inject it into this command without logging it.

With an authenticated Auth0 CLI, run `python3 tools/auth0/reconcile.py` to check,
or add `--apply` to reconcile and recheck. Exit 0 means the configuration matches,
1 means drift, and 2 means a missing/ambiguous identity, invalid mapping or API error.
Use the same environment for both commands. No deployment is triggered.

The reconciler requires every named client and mapped user to already exist.
It adds missing managed API scopes, enables RBAC, adds missing client/user
permissions and keeps the qyl third-party default grant empty. It preserves all
other scopes, grants, users, application settings and tenant settings. Changing
which user owns a project remains a separate deployment mapping operation.
API responses, subject identifiers and secrets are never printed. The Events
client credential remains in Vitals/Railway; checking this policy never rotates it.
