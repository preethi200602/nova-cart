// Checks req.body against a zod schema.
// On failure: 400 with the project's usual { error } shape.
// On success: replaces req.body with the cleaned data.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue.path.join(".");
      return res
        .status(400)
        .json({ error: field ? `${field}: ${issue.message}` : issue.message });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
