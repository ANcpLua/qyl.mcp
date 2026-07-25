import type { RequestHandler } from "express";
import { Constants } from "./constants.js";
import { sendForbidden } from "./problems.js";

const LoopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const WorkbenchAllowedOrigins = [
    `http://127.0.0.1:${Constants.Ports.Workbench}`,
    `http://localhost:${Constants.Ports.Workbench}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
] as const;

function hostnameFromAuthority(authority: string): string | undefined {
    try {
        return new URL(`http://${authority}`).hostname;
    } catch {
        return undefined;
    }
}

/**
 * Protect an unauthenticated loopback HTTP surface from DNS rebinding and
 * cross-origin browser requests. Requests without Origin remain valid for
 * command-line clients; browser origins must be one of the known local hosts.
 */
export function loopbackRequestGuard(allowedOrigins: readonly string[]): RequestHandler {
    const originSet = new Set(allowedOrigins);
    return (request, response, next) => {
        const hostname = request.headers.host
            ? hostnameFromAuthority(request.headers.host)
            : undefined;
        if (hostname === undefined || !LoopbackHostnames.has(hostname)) {
            sendForbidden(response, "Requests must use a loopback Host header.");
            return;
        }

        const origin = request.headers.origin;
        if (origin !== undefined && !originSet.has(origin)) {
            sendForbidden(response, "The request Origin is not allowed.");
            return;
        }

        next();
    };
}
