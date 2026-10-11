#!/usr/bin/env python3
"""Check/apply only qyl-owned Auth0 scopes, existing client grants and mapped users.

Uses the authenticated Auth0 CLI. Secrets and subject/client identifiers are never
printed or saved. --apply reconciles missing managed permissions; it never deletes
unrelated scopes, clients, users or grants. No applications/users are created.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote


class Auth0:
    def __init__(self, tenant):
        self.tenant = tenant

    def request(self, method, path, data=None, query=()):
        command = ["auth0", "api", method, path, "--tenant", self.tenant]
        for item in query:
            command += ["-q", item]
        if data is not None:
            command += ["--data", "@-"]
        try:
            result = subprocess.run(command, input=None if data is None else json.dumps(data),
                                    capture_output=True, text=True, timeout=60, check=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Auth0 request timed out") from None
        if result.returncode:
            # Neither output stream is safe: errors can contain tokens or identities.
            raise RuntimeError(f"Auth0 {method} request failed; check CLI credentials and permissions")
        return json.loads(result.stdout) if result.stdout.strip() else None

    def list(self, path, query=()):
        entries = []
        for page in range(100):
            batch = self.request("get", path, query=(*query, "per_page=100", f"page={page}"))
            if not isinstance(batch, list):
                raise RuntimeError("Unexpected Auth0 list response")
            entries.extend(batch)
            if len(batch) < 100:
                return entries
        raise RuntimeError("Auth0 pagination exceeded safety bound")


def single(entries, predicate, description):
    matches = [entry for entry in entries if predicate(entry)]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one existing {description}; found {len(matches)}")
    return matches[0]


def merged_scopes(existing, required):
    return sorted(set(existing) | set(required))


def mapped_subjects(config, environment):
    name = config["user_subjects_environment"]
    try:
        mapping = json.loads(environment[name])
        subjects = {subject for project in mapping for subject in project["subjects"]}
        if not subjects or any(not isinstance(subject, str) or not subject.strip() for subject in subjects):
            raise ValueError()
        return sorted(subjects)
    except (KeyError, TypeError, ValueError):
        raise RuntimeError(f"{name} must contain the existing project mapping with verified subjects") from None


def plan(api, config, environment):
    resource_name = config["resource"]["identifier"]
    resources = api.list("resource-servers")
    resource = single(resources, lambda item: item.get("identifier") == resource_name, "qyl API")
    clients = api.list("clients", ("fields=client_id,name,app_type", "include_fields=true"))
    grants = api.list("client-grants")
    changes = []

    desired_scopes = {scope["value"]: scope for scope in config["resource"]["scopes"]}
    existing_scopes = {scope["value"]: scope for scope in resource.get("scopes", [])}
    missing = desired_scopes.keys() - existing_scopes.keys()
    patch = {}
    if missing:
        patch["scopes"] = list(existing_scopes.values()) + [desired_scopes[key] for key in sorted(missing)]
    if resource.get("enforce_policies") != config["resource"]["enforce_policies"]:
        patch["enforce_policies"] = config["resource"]["enforce_policies"]
    if patch:
        changes.append(("qyl API permissions", "patch", f"resource-servers/{resource['id']}", patch))

    def grant_for(client_name, audience, subject_type, required, app_type=None):
        client = single(clients, lambda item: item.get("name") == client_name, f"client {client_name}")
        if app_type and client.get("app_type") != app_type:
            raise RuntimeError(f"Existing client {client_name} has an unexpected application type")
        matches = [grant for grant in grants if grant.get("client_id") == client["client_id"]
                   and grant.get("audience") == audience and grant.get("subject_type") == subject_type]
        if len(matches) > 1:
            raise RuntimeError(f"Ambiguous existing grant for {client_name}")
        if not matches:
            changes.append((f"client grant: {client_name}", "post", "client-grants", {
                "client_id": client["client_id"], "audience": audience,
                "subject_type": subject_type, "scope": sorted(required)}))
        elif not set(required) <= set(matches[0].get("scope", [])):
            grant = matches[0]
            changes.append((f"client grant: {client_name}", "patch", f"client-grants/{grant['id']}", {
                "scope": merged_scopes(grant.get("scope", []), required)}))

    for client_name in config["user_client_names"]:
        grant_for(client_name, resource_name, "user", config["user_scopes"])
    management = config["management_client"]
    grant_for(management["name"], f"https://{config['tenant']}/api/v2/", "client",
              management["scope"], management["app_type"])

    default = single(grants, lambda grant: grant.get("audience") == resource_name
                     and grant.get("subject_type") == "user"
                     and grant.get("default_for") == "third_party_clients", "third-party default grant")
    if any(default.get(key) != value for key, value in config["third_party_default"].items()):
        changes.append(("qyl third-party default grant", "patch", f"client-grants/{default['id']}",
                        config["third_party_default"]))

    subjects = mapped_subjects(config, environment)
    for index, subject in enumerate(subjects, 1):
        path = f"users/{quote(subject, safe='')}"
        user = api.request("get", path, query=("fields=user_id,blocked", "include_fields=true"))
        if user.get("user_id") != subject or user.get("blocked"):
            raise RuntimeError(f"Mapped user {index} is missing or blocked")
        permissions = api.list(f"{path}/permissions")
        present = {permission["permission_name"] for permission in permissions
                   if permission.get("resource_server_identifier") == resource_name}
        missing = set(config["user_scopes"]) - present
        if missing:
            changes.append((f"mapped user {index} permissions", "post", f"{path}/permissions", {
                "permissions": [{"resource_server_identifier": resource_name, "permission_name": scope}
                                for scope in sorted(missing)]}))
    return changes, len(subjects)


def reconcile(api, config, environment, apply=False, report=print):
    # Finish the read-only plan before making the first mutation. Missing or
    # ambiguous identities therefore fail before any policy can be changed.
    changes, count = plan(api, config, environment)
    report(f"Checked qyl API, {len(config['user_client_names'])} user clients, Events client, default grant, {count} mapped users")
    for label, method, path, body in changes:
        report(f"{'Apply' if apply else 'Drift'}: {label}")
        if apply:
            api.request(method, path, body)
    if apply and changes:
        remaining, _ = plan(api, config, environment)
        if remaining:
            raise RuntimeError("Auth0 verification found remaining drift")
    report("Auth0 configuration matches" if not changes or apply else "Auth0 configuration has drift")
    return 0 if not changes or apply else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("tenant.json"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    return reconcile(Auth0(config["tenant"]), config, os.environ, args.apply)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError) as error:
        # Config/parser/CLI errors must not expose any raw API data.
        print(str(error) if isinstance(error, RuntimeError) else "Invalid configuration or CLI unavailable", file=sys.stderr)
        sys.exit(2)
