#!/usr/bin/env python3
"""Apply the qyl Events access policy through authenticated Auth0/Railway CLIs.

Prints a plan unless --apply is given. Secrets pass through process memory and
Railway stdin; they are never written to files or printed. No Git or vault use.
Existing unrelated applications and grants are preserved.
"""
import argparse
import json
import subprocess
import sys
from urllib.parse import quote

ISSUER = "https://qyl-eu.eu.auth0.com/"
RESOURCE = "https://mcp.qyl.at/mcp"
SCOPES = ["read:users", "read:client_grants", "read:grants"]
APPLICATION = "qyl.mcp Events access check"


def auth(method, path, data=None, query=()):
    args = ["auth0", "api", method, path]
    for item in query:
        args += ["-q", item]
    if data is not None:
        args += ["--data", "@-"]
    result = subprocess.run(args, input=None if data is None else json.dumps(data),
                            text=True, capture_output=True, check=False)
    if result.returncode:
        # Do not echo bodies: a client response could include credentials.
        try:
            error = json.loads(result.stderr).get("error", {})
            reason = error.get("reason", error.get("code", "request_failed"))
        except (ValueError, AttributeError):
            reason = "request_failed"
        raise RuntimeError(f"Auth0 {method} {path}: {reason}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def client_grant(client_id, audience, scope, subject_type):
    grants = auth("get", "client-grants", query=(
        f"client_id={client_id}", f"audience={audience}", f"subject_type={subject_type}"))
    explicit = [g for g in grants if g.get("client_id") == client_id
                and g.get("audience") == audience and g.get("subject_type") == subject_type]
    if explicit:
        if set(explicit[0]["scope"]) != set(scope):
            auth("patch", f"client-grants/{explicit[0]['id']}", {"scope": scope})
    else:
        auth("post", "client-grants", {"client_id": client_id, "audience": audience,
             "scope": scope, "subject_type": subject_type})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True, help="Intended qyl user's verified Auth0 subject")
    parser.add_argument("--project-id", required=True, help="Existing Railway qyl project")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    resources = auth("get", "resource-servers")
    resource = next(r for r in resources if r.get("identifier") == RESOURCE)
    user_path = f"users/{quote(args.user_id, safe='')}"
    user = auth("get", user_path, query=("fields=user_id,blocked", "include_fields=true"))
    if user.get("user_id") != args.user_id or user.get("blocked"):
        raise RuntimeError("The intended user is missing or blocked")
    grants = auth("get", "grants", query=(f"user_id={args.user_id}", f"audience={RESOURCE}", "per_page=100"))
    consented_clients = sorted({g["clientID"] for g in grants if g.get("user_id") == args.user_id
                               and g.get("audience") == RESOURCE and "qyl:read" in g.get("scope", [])})
    if not consented_clients:
        raise RuntimeError("The intended user has no existing qyl:read consent to preserve")
    defaults = auth("get", "client-grants", query=(f"audience={RESOURCE}", "per_page=100"))
    plan = {
        "resource": RESOURCE,
        "resource_settings": {"enforce_policies": True, "skip_consent_for_verifiable_first_party_clients": False},
        "tenant_settings": {"dynamic_client_registration_security_mode": "strict"},
        "intended_user_permission": "qyl:read",
        "preserve_consented_clients": consented_clients,
        "third_party_default_scopes": [],
        "management_application": APPLICATION,
        "management_scopes": SCOPES,
        "railway_service": "qyl-mcp",
        "railway_environment": "production",
        "railway_variables": ["MCP_EVENTS_AUTH0_CLIENT_ID", "MCP_EVENTS_AUTH0_CLIENT_SECRET"],
        "automatic_deploys": False,
    }
    print(json.dumps(plan, indent=2), flush=True)
    if not args.apply:
        return

    # Preserve the existing user's granted access before narrowing the defaults.
    auth("post", f"{user_path}/permissions", {"permissions": [
        {"resource_server_identifier": RESOURCE, "permission_name": "qyl:read"}]})
    for client in consented_clients:
        existing = next((g for g in defaults if g.get("client_id") == client
                         and g.get("subject_type") == "user"), None)
        scope = sorted(set((existing or {}).get("scope", [])) | {"qyl:read"})
        client_grant(client, RESOURCE, scope, "user")
    auth("patch", f"resource-servers/{resource['id']}", plan["resource_settings"])
    auth("patch", "tenants/settings", plan["tenant_settings"])
    for grant in defaults:
        if grant.get("default_for") == "third_party_clients" and grant.get("subject_type") == "user":
            auth("patch", f"client-grants/{grant['id']}", {"scope": [], "allow_all_scopes": False})

    clients = auth("get", "clients", query=("fields=client_id,name,app_type", "per_page=100"))
    matching = [c for c in clients if c.get("name") == APPLICATION]
    if len(matching) > 1:
        raise RuntimeError("More than one Events access-check application exists")
    if matching:
        if matching[0].get("app_type") != "non_interactive":
            raise RuntimeError("The Events application is not a machine application")
        client = auth("get", f"clients/{matching[0]['client_id']}", query=("fields=client_id,client_secret",))
    else:
        client = auth("post", "clients", {
            "name": APPLICATION, "app_type": "non_interactive", "is_first_party": True,
            "grant_types": ["client_credentials"], "token_endpoint_auth_method": "client_secret_post",
            "description": "Read-only current authorization checks for qyl MCP Events",
        })
    client_grant(client["client_id"], f"{ISSUER}api/v2/", SCOPES, "client")
    for key, value in [("MCP_EVENTS_AUTH0_CLIENT_ID", client["client_id"]),
                       ("MCP_EVENTS_AUTH0_CLIENT_SECRET", client["client_secret"])]:
        result = subprocess.run([
            "railway", "variable", "set", "--project", args.project_id,
            "--environment", "production", "--service", "qyl-mcp", "--skip-deploys", "--stdin", key,
        ], input=value, text=True, capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError(f"Railway could not set {key}; no credentials printed")
    print("Applied qyl access policy and Events credentials; deployment remains separate.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
