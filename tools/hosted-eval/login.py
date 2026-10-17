#!/usr/bin/env python3
"""Bearer token for the hosted qyl MCP server, https://mcp.qyl.at/mcp.

Order of preference, so the browser is needed once and then never:
  1. A refresh token in the login Keychain (service qyl-mcp-hosted-refresh) is
     exchanged for a fresh access token. No browser, no prompt.
  2. Otherwise: reuse the registered public client from the Keychain (or
     QYL_MCP_OAUTH_CLIENT_ID), start a loopback listener, write the authorize
     URL to authorize-url.txt, and store the refreshed login in the Keychain.
     Anonymous dynamic registration is not required or enabled by this tool.

The access token goes to out/hosted-token.json (mode 600) beside this script, or to
--out. Nothing secret is printed. Prints one `ok:` line on success.
"""
import argparse, base64, hashlib, http.server, json, os, re, secrets, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"), exist_ok=True)

HERE = os.path.dirname(os.path.abspath(__file__))
ISSUER = "https://qyl-eu.eu.auth0.com/"
RESOURCE = "https://mcp.qyl.at/mcp"
PORT = 48731
REDIRECT = f"http://127.0.0.1:{PORT}/callback"
KC_REFRESH = "qyl-mcp-hosted-refresh"     # value: refresh token
KC_CLIENT = "qyl-mcp-hosted-client-id"    # registered public client id, kept beside the token
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--browser", action="store_true", help="Request a fresh browser authorization instead of refreshing")
parser.add_argument("--scope", default="qyl:read offline_access", help="Space-separated OAuth scopes to request")
parser.add_argument("--profile", default="default", help="Separate Keychain account for this login; the registered public client may be shared")
parser.add_argument("--out", help="Token output path (mode 600)")
parser.add_argument("--print-token-path", action="store_true", help="Print the resolved output path without authentication")
args = parser.parse_args()
if not re.fullmatch(r"[A-Za-z0-9_-]+", args.profile):
    parser.error("--profile must be a single name containing letters, digits, underscores or hyphens")
SCOPE = " ".join(dict.fromkeys(args.scope.split()))
if not SCOPE:
    parser.error("--scope must contain at least one scope")
KC_ACCOUNT = "qyl" if args.profile == "default" else f"qyl-{args.profile}"
token_name = "hosted-token.json" if args.profile == "default" else f"hosted-{args.profile}-token.json"
out_file = args.out or os.path.join(HERE, "out", token_name)
if args.print_token_path:
    print(out_file)
    sys.exit(0)
force_browser = args.browser

def kc_get(service, account=KC_ACCOUNT):
    r = subprocess.run(["security", "find-generic-password", "-a", account, "-s", service, "-w"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None

def kc_set(service, value):
    subprocess.run(["security", "add-generic-password", "-a", KC_ACCOUNT, "-s", service, "-w", value, "-U"], check=True, capture_output=True)

def post_form(url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def save(token):
    fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump({"access_token": token["access_token"], "token_type": token.get("token_type"),
                   "expires_in": token.get("expires_in"), "scope": token.get("scope"), "obtained_at": int(time.time())}, f)
    if token.get("refresh_token"):
        kc_set(KC_REFRESH, token["refresh_token"])

meta = json.load(urllib.request.urlopen(ISSUER + ".well-known/oauth-authorization-server", timeout=30))

# 1. refresh without a browser
refresh = kc_get(KC_REFRESH)
client_id = os.environ.get("QYL_MCP_OAUTH_CLIENT_ID") or kc_get(KC_CLIENT) or kc_get(KC_CLIENT, "qyl")
if refresh and client_id and not force_browser:
    try:
        token = post_form(meta["token_endpoint"], {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": refresh, "resource": RESOURCE, "scope": SCOPE})
        # Preserve a rotated refresh credential even if broader consent is still needed.
        if token.get("refresh_token"):
            kc_set(KC_REFRESH, token["refresh_token"])
        if set(SCOPE.split()).issubset(token.get("scope", SCOPE).split()):
            save(token)
            print(f"ok: token refreshed from Keychain, scope={token.get('scope')!r} expires_in={token.get('expires_in')}s -> {out_file}", flush=True)
            sys.exit(0)
        print("refreshed token lacks requested scopes; requesting browser consent", flush=True)
    except urllib.error.HTTPError as e:
        print(f"refresh failed ({e.code}); falling back to the browser", flush=True)

# 2. browser flow: the tenant's existing managed client already has the intended grants.
if not client_id:
    sys.exit("Configure the existing public hosted-eval client in QYL_MCP_OAUTH_CLIENT_ID or the qyl-mcp-hosted-client-id Keychain entry; no anonymous registration was attempted.")
print("using the configured registered public client", flush=True)

verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_urlsafe(16)
authorize = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({
    "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT,
    "scope": SCOPE, "resource": RESOURCE, "audience": RESOURCE,
    "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
})
with open(os.path.join(HERE, "out", "authorize-url.txt"), "w") as f:
    f.write(authorize + "\n")
print(f"authorize url written to {os.path.join(HERE, 'out', 'authorize-url.txt')}", flush=True)

result, done = {}, threading.Event()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - silence the default access log
        pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/callback":
            self.send_response(404); self.end_headers(); return
        result.update({k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()})
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers()
        self.wfile.write(b"<html><body><h2>qyl hosted eval: login received. You can close this tab.</h2></body></html>")
        done.set()

srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("waiting for the browser callback (up to 15 minutes)", flush=True)
if not done.wait(900):
    sys.exit("timeout: no callback received")
srv.shutdown()
if result.get("state") != state:
    sys.exit("state mismatch on callback")
if "error" in result:
    sys.exit(f"authorization error: {result.get('error')}: {result.get('error_description')}")

token = post_form(meta["token_endpoint"], {"grant_type": "authorization_code", "client_id": client_id, "code": result["code"],
                                          "redirect_uri": REDIRECT, "code_verifier": verifier, "resource": RESOURCE})
kc_set(KC_CLIENT, client_id)
save(token)
print(f"ok: token acquired, scope={token.get('scope')!r} expires_in={token.get('expires_in')}s refresh_token_stored={bool(token.get('refresh_token'))} -> {out_file}", flush=True)
