/** Public composition surface for hosted resource authorization. */
export { createResourceAuthorization, type ResourceAuthorizationOptions } from "./authorization.js";
export {
  authorizationExtensions,
  clientCredentialsAuthorization,
  enterpriseManagedAuthorization,
  readAuthorizationExtensions,
  resolveAuthorizationExtensions,
  validateAuthorizationExtensions,
  type AuthorizationExtension,
} from "./auth-extensions.js";
export { createJwtTokenVerifier, loadHostedOAuth, type HostedOAuth } from "./oauth.js";
