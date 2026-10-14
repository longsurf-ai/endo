# CI

- Every PR and main push runs the four existing workspace check phases and the
  public-content gate. `just check` runs those same application checks locally.
- CI needs no private repository credentials.
- Actions have read-only repository access. Never run untrusted pull-request
  code with production credentials or use `pull_request_target` for builds.
- Application releases use the documented signing-Mac commands. CI does not
  publish updates or deploy separately owned hosted services.
