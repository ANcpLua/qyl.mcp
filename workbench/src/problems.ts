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
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail,
    };
    sendProblem(response, ForbiddenErrorSchema.parse(body));
}

export function sendUnauthorized(response: Response): void {
    const body: UnauthorizedError = {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "A valid local workbench session cookie is required.",
    };
    response.setHeader("WWW-Authenticate", "Cookie");
    sendProblem(response, UnauthorizedErrorSchema.parse(body));
}

export function sendNotFound(response: Response, resourceType: string, resourceId: string): void {
    const body: NotFoundError = {
        type: "about:blank",
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
        type: "about:blank",
        title: "Validation Failed",
        status: 400,
        detail: "The request is invalid.",
        errors: [{ field, message, code: "invalid" }],
    };
    sendProblem(response, ValidationErrorSchema.parse(body));
}

export function sendConflict(response: Response, resource: string, detail: string): void {
    const body: ConflictError = {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail,
        conflicting_resource: resource,
    };
    sendProblem(response, ConflictErrorSchema.parse(body));
}

export function sendBadGateway(response: Response): void {
    const body: BadGatewayError = {
        type: "about:blank",
        title: "Bad Gateway",
        status: 502,
        detail: "The upstream MCP operation failed.",
        dependency: "mcp",
    };
    sendProblem(response, BadGatewayErrorSchema.parse(body));
}

export function sendInternalServerError(response: Response): void {
    const body: InternalServerError = {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        detail: "The workbench could not complete the request.",
    };
    sendProblem(response, InternalServerErrorSchema.parse(body));
}
