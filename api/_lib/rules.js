// Writing rules every generated document and answer must pass.
// Mirrors JobHuntAgent/config/resume_rules.json, minus personal fields.
export default {
  max_pages: 2,
  // Titles never held: a summary may not open with these.
  banned_title_claims: ["^\\s*(Vice President|VP|Chief|Head of|Dean)\\b"],
  banned_phrases: ["successfully", "results-driven", "proven track record", "think outside the box", "wear many hats", "dynamic self-starter"],
};
