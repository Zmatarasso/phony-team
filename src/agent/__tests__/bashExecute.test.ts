import { checkMainBranchProtection, executeBash } from "../tools/bashExecute.js";

describe("checkMainBranchProtection", () => {
  // --- push to main ---
  it("blocks: git push origin main", () => {
    expect(checkMainBranchProtection("git push origin main")).not.toBeNull();
  });

  it("blocks: git push main", () => {
    expect(checkMainBranchProtection("git push main")).not.toBeNull();
  });

  it("blocks: git push --force origin main", () => {
    expect(checkMainBranchProtection("git push --force origin main")).not.toBeNull();
  });

  it("blocks: git push origin HEAD:main", () => {
    expect(checkMainBranchProtection("git push origin HEAD:main")).not.toBeNull();
  });

  it("blocks: git push origin feature:main", () => {
    expect(checkMainBranchProtection("git push origin feature/foo:main")).not.toBeNull();
  });

  // --- push to master ---
  it("blocks: git push origin master", () => {
    expect(checkMainBranchProtection("git push origin master")).not.toBeNull();
  });

  it("blocks: git push --force-with-lease origin master", () => {
    expect(checkMainBranchProtection("git push --force-with-lease origin master")).not.toBeNull();
  });

  // --- branch deletion ---
  it("blocks: git branch -d main", () => {
    expect(checkMainBranchProtection("git branch -d main")).not.toBeNull();
  });

  it("blocks: git branch -D main", () => {
    expect(checkMainBranchProtection("git branch -D main")).not.toBeNull();
  });

  it("blocks: git branch --delete main", () => {
    expect(checkMainBranchProtection("git branch --delete main")).not.toBeNull();
  });

  it("blocks: git branch --force-delete main", () => {
    expect(checkMainBranchProtection("git branch --force-delete main")).not.toBeNull();
  });

  // --- force-recreate ---
  it("blocks: git checkout -B main", () => {
    expect(checkMainBranchProtection("git checkout -B main")).not.toBeNull();
  });

  // --- hard reset ---
  it("blocks: git reset --hard main", () => {
    expect(checkMainBranchProtection("git reset --hard main")).not.toBeNull();
  });

  it("blocks: git reset --hard origin/main", () => {
    expect(checkMainBranchProtection("git reset --hard origin/main")).not.toBeNull();
  });

  // --- allowed operations ---
  it("allows: git push origin feature-branch", () => {
    expect(checkMainBranchProtection("git push origin feature-branch")).toBeNull();
  });

  it("allows: git push origin PHONY-1", () => {
    expect(checkMainBranchProtection("git push origin PHONY-1")).toBeNull();
  });

  it("allows: git checkout main (no -B)", () => {
    expect(checkMainBranchProtection("git checkout main")).toBeNull();
  });

  it("allows: git merge main (merging FROM main is allowed)", () => {
    expect(checkMainBranchProtection("git merge main")).toBeNull();
  });

  it("allows: git reset --soft HEAD~1", () => {
    expect(checkMainBranchProtection("git reset --soft HEAD~1")).toBeNull();
  });

  it("allows: git branch -d feature-branch", () => {
    expect(checkMainBranchProtection("git branch -d feature-branch")).toBeNull();
  });

  it("allows: echo 'git push origin main' (comment text in string, not actual command)", () => {
    // Comments aren't really protected here but plain non-git strings are fine
    expect(checkMainBranchProtection("echo 'some text about main'")).toBeNull();
  });
});

describe("executeBash", () => {
  it("returns stdout for a simple command", async () => {
    const result = await executeBash("echo hello", "/tmp");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("captures stderr separately", async () => {
    const result = await executeBash("echo error >&2", "/tmp");
    expect(result.stderr.trim()).toBe("error");
    expect(result.exit_code).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const result = await executeBash("exit 42", "/tmp");
    expect(result.exit_code).toBe(42);
  });

  it("blocks forbidden commands and returns exit_code 1", async () => {
    const result = await executeBash("git push origin main", "/tmp");
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("[symphony]");
  });

  it("runs in the specified cwd", async () => {
    const result = await executeBash("pwd", "/tmp");
    // /tmp may resolve to a different path on macOS (/private/tmp) so check suffix
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toMatch(/tmp$/);
  });
});
