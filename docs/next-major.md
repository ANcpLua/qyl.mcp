# Next release is 7.0.0

6.2.x shipped a contract major (attribute values and log bodies as `AttributeValue`) that changed the shape of tool output, and stayed a minor. That was wrong. The next change to any tool's output, including the identity change in `qyl-api-schema/docs/next-release.md`, ships as 7.0.0, and from then on a contract major moves this package's major with it.
