// The error the representation facade and eviction report to routes: an
// HTTP status, a stable code and, for refusals, the reasons.
class RepresentationError extends Error {
  constructor(status, code, message, reasons = []) {
    super(message);
    this.name = 'RepresentationError';
    this.status = status;
    this.code = code;
    this.reasons = reasons;
  }
}

module.exports = { RepresentationError };
