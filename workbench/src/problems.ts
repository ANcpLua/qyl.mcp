import type {
    BadGatewayError,
    ConflictError,
    ForbiddenError,
    InternalServerError,
    NotFoundError,
    ProblemDetails,
    UnauthorizedError,
    ValidationError,
} from "@ancplua/qyl-api-schema/types";
import type { Response } from "express";
import {
    BadGatewayErrorSchema,
    ConflictErrorSchema,
    ForbiddenErrorSchema,
    InternalServerErrorSchema,
    NotFoundErrorSchema,
    UnauthorizedErrorSchema,
    ValidationErrorSchema,
} from "qyl-mcp-server/contract-validation";

function sendProblem(response: Response, body: ProblemDetails): void {
    response.status(body.status).type("application/problem+json").json(body);
}

export function sendForbidden(response: Response, detail: string): void {
    const body: ForbiddenError = {
        type: "https://qyl.at/problems/forbidden",
        code: "forbidden",
        title: "Forbidden",
        status: 403,
        detail,
    };
    sendProblem(response, ForbiddenErrorSchema.parse(body));
}

export function sendUnauthorized(response: Response): void {
    const body: UnauthorizedError = {
        type: "https://qyl.at/problems/unauthorized",
        code: "unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "A valid local workbench session cookie is required.",
    };
    response.setHeader("WWW-Authenticate", "Cookie");
    sendProblem(response, UnauthorizedErrorSchema.parse(body));
}

export function sendNotFound(response: Response, resourceType: string, resourceId: string): void {
    const body: NotFoundError = {
        type: "https://qyl.at/problems/not-found",
        code: "not_found",
        title: "Not Found",
        status: 404,
        detail: `${resourceType} '${resourceId}' was not found.`,
        resource_type: resourceType,
        resource_id: resourceId,
    };
    sendProblem(response, NotFoundErrorSchema.parse(body));
}

export function sendValidationProblem(response: Response, field: string, message: string): void {
    const body: ValidationError = {
        type: "https://qyl.at/problems/validation-failed",
        code: "validation_failed",
        title: "Validation Failed",
        status: 400,
        detail: "The request is invalid.",
        errors: [{ field, message, code: "invalid" }],
    };
    sendProblem(response, ValidationErrorSchema.parse(body));
}

export function sendConflict(response: Response, resource: string, detail: string): void {
    const body: ConflictError = {
        type: "https://qyl.at/problems/conflict",
        code: "conflict",
        title: "Conflict",
        status: 409,
        detail,
        conflicting_resource: resource,
    };
    sendProblem(response, ConflictErrorSchema.parse(body));
}

export function sendBadGateway(response: Response): void {
    const body: BadGatewayError = {
        type: "https://qyl.at/problems/bad-gateway",
        code: "bad_gateway",
        title: "Bad Gateway",
        status: 502,
        detail: "The upstream MCP operation failed.",
        dependency: "mcp",
    };
    sendProblem(response, BadGatewayErrorSchema.parse(body));
}

export function sendInternalServerError(response: Response): void {
    const body: InternalServerError = {
        type: "https://qyl.at/problems/internal-error",
        code: "internal_error",
        title: "Internal Server Error",
        status: 500,
        detail: "The workbench could not complete the request.",
    };
    sendProblem(response, InternalServerErrorSchema.parse(body));
}
