import { getAgentDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { readToolConfig } from "./settings.ts";
import { buildSummaryPrompt, isGithubRepoPath, summarySessionName } from "./summary.ts";
import { writeChangelogFiles, type ChangelogSource, type ChangelogStore, type UpdateSummary } from "./changelog-store.ts";

import { Box, Text } from "@earendil-works/pi-tui";

const NPM_REGISTRY = "https://registry.npmjs.org";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours cooldown

/** The npm package that ships the running pi CLI. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_DISPLAY_NAME = "pi";

interface PackageUpdate {
  displayName: string;
  /** npm package to query when it differs from the display name, as it does for pi itself. */
  npmName?: string;
  source: string;
  type: "npm" | "git";
  currentVersion: string;
  latestVersion: string;
  installPath?: string;
}

function parseNpmSource(source: string): { name: string; tag?: string } | null {
  const match = source.match(/^npm:(@?[^@]+)(?:@(.+))?$/);
  if (!match) return null;
  return { name: match[1], tag: match[2] };
}

function parseGitSource(source: string): { host: string; path: string; ref?: string } | null {
  const match = source.match(/^git:([^/]+)\/(.+?)(?:@(.+))?$/);
  if (!match) return null;
  return { host: match[1], path: match[2], ref: match[3] };
}

/** `git:github.com/owner/repo@ref` -> `https://github.com/owner/repo`; null for other hosts. */
function gitSourceRepoUrl(source: string): string | null {
  const parsed = parseGitSource(source);
  if (!parsed || parsed.host !== "github.com") return null;
  return `https://github.com/${parsed.path}`;
}

async function getInstalledVersion(packageName: string, agentDir: string): Promise<string | null> {
  try {
    const pkgJsonPath = join(agentDir, "npm", "node_modules", packageName, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    const content = await readFile(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestNpmVersion(packageName: string): Promise<string | null> {
  try {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    return data["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const parseV = (v: string) => {
    const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [0, 0, 0];
  };
  const l = parseV(latest);
  const c = parseV(current);
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "pi-coding-agent",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

/** `https://github.com/owner/repo.git` -> `owner/repo`; null for anything not on GitHub. */
function githubRepoFromUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1].replace(/\.git$/, "") : null;
}

async function fetchGithubChangelogFile(ownerSlashRepo: string): Promise<string | null> {
  const branches = ["main", "master"];
  const files = ["CHANGELOG.md", "changelog.md", "CHANGELOG", "HISTORY.md", "history.md"];
  
  for (const branch of branches) {
    for (const file of files) {
      try {
        const url = `https://raw.githubusercontent.com/${ownerSlashRepo}/${branch}/${file}`;
        const res = await fetch(url, { method: "GET" });
        if (res.ok) {
          const text = await res.text();
          if (text && text.trim().length > 10) {
            return text;
          }
        }
      } catch {
        // check next combination
      }
    }
  }
  return null;
}

async function fetchLocalChangelogFile(installPath: string): Promise<string | null> {
  const files = ["CHANGELOG.md", "changelog.md", "CHANGELOG", "HISTORY.md", "history.md"];
  for (const file of files) {
    try {
      const p = join(installPath, file);
      if (existsSync(p)) {
        const text = await readFile(p, "utf-8");
        if (text && text.trim().length > 10) {
          return text;
        }
      }
    } catch {
      // check next
    }
  }
  return null;
}

/** `sha date subject` per commit, the shape both compare and recent-commit fetches report. */
function formatGitHubCommits(commits: any[]): string {
  return commits.map((c: any) => {
    const hash = c.sha.slice(0, 7);
    const date = c.commit.author?.date ? c.commit.author.date.slice(0, 10) : "";
    const msg = c.commit.message.split('\n')[0];
    return `${hash} ${date} ${msg}`;
  }).join('\n');
}

/**
 * Recent commits, for packages that publish neither releases, version tags, nor a changelog — the
 * commit log is then the only record of what changed.
 */
async function fetchGitHubRecentCommits(ownerRepo: string, perPage = 30): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${ownerRepo}/commits?per_page=${perPage}`;
    const res = await fetch(url, { headers: getGitHubHeaders() });
    if (!res.ok) return null;
    const commits = (await res.json()) as any[];
    if (!commits.length) return null;
    return formatGitHubCommits(commits);
  } catch {
    return null;
  }
}

/**
 * The commits between two versions. Only the delta is returned: commits older than the installed
 * version are not part of the update, so they would add noise without answering what changed.
 */
async function fetchGitHubCommits(ownerRepo: string, base: string, head: string): Promise<string | null> {
  try {
    const headers = getGitHubHeaders();
    let compareUrl = `https://api.github.com/repos/${ownerRepo}/compare/v${base}...v${head}`;
    let compareRes = await fetch(compareUrl, { headers });

    if (!compareRes.ok) {
      compareUrl = `https://api.github.com/repos/${ownerRepo}/compare/${base}...${head}`;
      compareRes = await fetch(compareUrl, { headers });
    }
    if (!compareRes.ok) return null;

    const data = (await compareRes.json()) as any;
    if (!data.commits || !data.commits.length) return null;
    return formatGitHubCommits(data.commits.reverse());
  } catch {
    return null;
  }
}

interface NpmPackageDoc {
  repoUrl: string | null;
  readme: string | null;
}

/** Registry data for one package version: where the source lives and the readme it publishes. */
async function fetchNpmPackageDoc(packageName: string, version: string): Promise<NpmPackageDoc> {
  try {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}/${version}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return { repoUrl: null, readme: null };
    const data = (await response.json()) as any;

    const repo = data.repository;
    let repoUrl: string | null = null;
    if (typeof repo === "object" && repo?.url) repoUrl = repo.url;
    else if (typeof repo === "string") repoUrl = repo;
    if (repoUrl) {
      repoUrl = repoUrl.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
    }

    return { repoUrl, readme: data.readme ?? null };
  } catch {
    return { repoUrl: null, readme: null };
  }
}

/** The changelog section of an npm readme, or null when the readme has none. */
function readmeChangelogSection(readme: string | null): string | null {
  if (!readme) return null;
  const section = readme.match(/#{1,3}\s+changelog[\s\S]*?(?=#{1,2}\s+[A-Z]|$)/i);
  return section ? section[0].trim() : null;
}

/** One changelog body for display: release notes when the repo has them, else the readme. */
async function fetchNpmChangelog(packageName: string, version: string): Promise<{ changelog: string | null; repoUrl: string | null }> {
  const { repoUrl, readme } = await fetchNpmPackageDoc(packageName, version);

  const githubRepo = githubRepoFromUrl(repoUrl);
  if (githubRepo) {
    const releases = await fetchGitHubReleases(githubRepo);
    if (releases) return { changelog: releases, repoUrl };
  }

  const section = readmeChangelogSection(readme);
  if (section) return { changelog: section.slice(0, 3000), repoUrl };

  return { changelog: readme ? readme.slice(0, 2000) : null, repoUrl };
}

/**
 * Every source available for one npm package, untruncated, for the on-disk store. The fetches run
 * in parallel but are collected in a fixed order so files and prompt stay stable between runs.
 */
async function collectNpmSources(
  displayName: string,
  latestVersion: string,
  installedVersion: string | null,
  options: { includeCommits?: boolean } = {},
): Promise<{ sources: ChangelogSource[]; repoUrl: string | null }> {
  const { repoUrl, readme } = await fetchNpmPackageDoc(displayName, latestVersion);
  const githubRepo = githubRepoFromUrl(repoUrl);
  const includeCommits = options.includeCommits ?? true;

  const [releases, changelogFile, commits] = await Promise.all([
    githubRepo ? fetchGitHubReleases(githubRepo, installedVersion ?? undefined) : Promise.resolve(null),
    githubRepo ? fetchGithubChangelogFile(githubRepo) : Promise.resolve(null),
    githubRepo && includeCommits && installedVersion && installedVersion !== latestVersion
      ? fetchGitHubCommits(githubRepo, installedVersion, latestVersion)
      : Promise.resolve(null),
  ]);

  const sources: ChangelogSource[] = [];
  if (releases) sources.push({ label: "GitHub releases", file: "releases.md", text: releases });
  if (changelogFile) sources.push({ label: "CHANGELOG.md", file: "changelog.md", text: changelogFile });
  if (commits) sources.push({ label: `Commits ${installedVersion}...${latestVersion}`, file: "commits.md", text: commits });

  const section = readmeChangelogSection(readme);
  if (section) sources.push({ label: "npm readme changelog", file: "readme-changelog.md", text: section });

  // A package can publish nothing: no releases, no tags to compare, no changelog file, no readme
  // section. Without a fallback such a package produces an empty summary, so try the commit log
  // and then the readme before giving up.
  if (sources.length === 0 && githubRepo) {
    const recent = await fetchGitHubRecentCommits(githubRepo);
    if (recent) {
      sources.push({ label: "Recent commits (no version tags in the repository)", file: "recent-commits.md", text: recent });
    }
  }
  if (sources.length === 0 && readme) {
    sources.push({ label: "npm readme", file: "readme.md", text: readme });
  }

  return { sources, repoUrl };
}

async function fetchGitHubReleases(ownerSlashRepo: string, installedVersion?: string): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${ownerSlashRepo}/releases?per_page=15`;
    const response = await fetch(url, { headers: getGitHubHeaders() });
    if (!response.ok) return null;
    const releases = (await response.json()) as any[];
    if (!releases.length) return null;

    let visible = releases.slice(0, 15);
    if (installedVersion) {
      const installedIndex = visible.findIndex(
        (r: any) => r.tag_name === installedVersion || r.tag_name === `v${installedVersion}`,
      );
      // Releases older than the installed version are not part of the update. Tags that do not
      // match (or are missing from the first page) keep the full list.
      if (installedIndex >= 0) visible = visible.slice(0, installedIndex + 1);
    }

    return visible.map((r: any) => {
      let title = `## ${r.tag_name} (${r.published_at?.slice(0, 10) ?? "unknown"})`;
      if (installedVersion && (r.tag_name === installedVersion || r.tag_name === `v${installedVersion}`)) {
        title += `  <-- INSTALLED VERSION`;
      }
      return `${title}\n${r.body ?? "No release notes."}`;
    }).join("\n\n");
  } catch {
    return null;
  }
}

async function readGitLog(installPath: string, args: string[], pi: ExtensionAPI): Promise<string> {
  try {
    const res = await pi.exec("git", [...args, "--format=%h %cd %s", "--date=short", "--no-color"], {
      cwd: installPath,
      timeout: 10000,
    });
    return res.code === 0 ? res.stdout.trim() : "";
  } catch {
    return "";
  }
}

/** Every local source for a git-installed package, one file per source for the model to read. */
async function collectGitSources(installPath: string, pi: ExtensionAPI): Promise<ChangelogSource[]> {
  const [pending, recent, changelog] = await Promise.all([
    readGitLog(installPath, ["log", "HEAD..FETCH_HEAD"], pi),
    readGitLog(installPath, ["log", "-n", "15"], pi),
    fetchLocalChangelogFile(installPath),
  ]);

  const sources: ChangelogSource[] = [];
  if (pending) sources.push({ label: "New commits (HEAD..FETCH_HEAD)", file: "commits.md", text: pending });
  if (recent) sources.push({ label: "Recent commits", file: "recent-commits.md", text: recent });
  if (changelog) sources.push({ label: "CHANGELOG.md", file: "changelog.md", text: changelog });
  return sources;
}

export default async function (pi: ExtensionAPI) {
  const toolConfig = await readToolConfig();
  let lastCheckTime = 0;

  /** pi itself is not listed in settings.json, so it is compared against the running build. */
  async function checkPiUpdate(): Promise<PackageUpdate | null> {
    const latestVersion = await getLatestNpmVersion(PI_PACKAGE);
    if (!latestVersion || !isNewerVersion(latestVersion, VERSION)) return null;
    return {
      displayName: PI_DISPLAY_NAME,
      npmName: PI_PACKAGE,
      source: `npm:${PI_PACKAGE}`,
      type: "npm",
      currentVersion: VERSION,
      latestVersion,
    };
  }

  async function checkUpdates(pi: ExtensionAPI): Promise<PackageUpdate[]> {
    const agentDir = getAgentDir();
    const settingsPath = join(agentDir, "settings.json");
    let packages: any[] = [];
    try {
      packages = JSON.parse(await readFile(settingsPath, "utf-8")).packages ?? [];
    } catch { return []; }

    const seen = new Set<string>();
    const checks = packages.map(async (pkg): Promise<PackageUpdate | null> => {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      if (!source || seen.has(source)) return null;
      seen.add(source);

      if (source.startsWith("/") || source.startsWith(".") || source.startsWith("file:")) return null;
      if (source.match(/@\d+\.\d+\.\d+$/)) return null;

      const npmParsed = parseNpmSource(source);
      if (npmParsed) {
        const installedVersion = await getInstalledVersion(npmParsed.name, agentDir);
        if (!installedVersion) return null;
        const latestVersion = await getLatestNpmVersion(npmParsed.name);
        if (!latestVersion || !isNewerVersion(latestVersion, installedVersion)) return null;

        return {
          displayName: npmParsed.name,
          currentVersion: installedVersion,
          latestVersion,
          source,
          type: "npm",
        };
      }

      const gitParsed = parseGitSource(source);
      if (gitParsed) {
        const installPath = join(agentDir, "git", gitParsed.host, gitParsed.path);
        if (!existsSync(installPath)) return null;
        
        try {
          await pi.exec("git", ["fetch", "--quiet"], { cwd: installPath, timeout: 15000 });
          const res = await pi.exec("git", ["log", "HEAD..FETCH_HEAD", "--oneline"], { cwd: installPath, timeout: 5000 });
          if (res.code === 0 && res.stdout.trim() !== "") {
            return {
              displayName: `${gitParsed.host}/${gitParsed.path}`,
              currentVersion: "installed",
              latestVersion: "remote",
              source,
              type: "git",
              installPath,
            };
          }
        } catch {}
      }
      return null;
    });

    const [piUpdate, extensionUpdates] = await Promise.all([
      checkPiUpdate(),
      Promise.all(checks),
    ]);
    const updates = extensionUpdates.filter((r): r is PackageUpdate => r !== null);
    return piUpdate ? [piUpdate, ...updates] : updates;
  }

  /** Fetches every changelog source for each package with an update waiting. */
  async function collectUpdateSummaries(): Promise<UpdateSummary[]> {
    const updates = await checkUpdates(pi);
    return Promise.all(
      updates.map(async (update): Promise<UpdateSummary> => {
        if (update.type === "npm") {
          const packageName = update.npmName ?? update.displayName;
          const { sources, repoUrl } = await collectNpmSources(
            packageName,
            update.latestVersion,
            update.currentVersion,
            { includeCommits: packageName !== PI_PACKAGE },
          );
          return {
            displayName: update.displayName,
            currentVersion: update.currentVersion,
            latestVersion: update.latestVersion,
            repoUrl,
            sources,
          };
        }

        return {
          displayName: update.displayName,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion,
          repoUrl: update.source ? gitSourceRepoUrl(update.source) : null,
          sources: update.installPath ? await collectGitSources(update.installPath, pi) : [],
        };
      }),
    );
  }

  /** Collects every source for one npm package name or one owner/repo path. */
  async function collectTargetSummary(target: string): Promise<UpdateSummary[]> {
    if (target === PI_DISPLAY_NAME || target === PI_PACKAGE) {
      const latestVersion = (await getLatestNpmVersion(PI_PACKAGE)) ?? "unknown";
      const { sources, repoUrl } = await collectNpmSources(
        PI_PACKAGE,
        latestVersion === "unknown" ? "latest" : latestVersion,
        VERSION,
        { includeCommits: false },
      );

      return [{
        displayName: PI_DISPLAY_NAME,
        currentVersion: VERSION,
        latestVersion,
        repoUrl,
        sources,
      }];
    }

    if (isGithubRepoPath(target)) {
      const [releases, changelogFile] = await Promise.all([
        fetchGitHubReleases(target),
        fetchGithubChangelogFile(target),
      ]);

      const sources: ChangelogSource[] = [];
      if (releases) sources.push({ label: "GitHub releases", file: "releases.md", text: releases });
      if (changelogFile) sources.push({ label: "CHANGELOG.md", file: "changelog.md", text: changelogFile });

      if (sources.length === 0) {
        const recent = await fetchGitHubRecentCommits(target);
        if (recent) {
          sources.push({ label: "Recent commits (no releases or changelog in the repository)", file: "recent-commits.md", text: recent });
        }
      }

      return [{
        displayName: target,
        currentVersion: "unknown",
        latestVersion: "latest",
        repoUrl: `https://github.com/${target}`,
        sources,
      }];
    }

    const installedVersion = await getInstalledVersion(target, getAgentDir());
    const latestVersion = (await getLatestNpmVersion(target)) ?? "unknown";
    const { sources, repoUrl } = await collectNpmSources(
      target,
      latestVersion === "unknown" ? "latest" : latestVersion,
      installedVersion,
    );

    return [{
      displayName: target,
      currentVersion: installedVersion ?? "not installed",
      latestVersion,
      repoUrl,
      sources,
    }];
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (process.env.PI_OFFLINE) return;
    if (!ctx.hasUI) return;

    const now = Date.now();
    if (now - lastCheckTime < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheckTime = now;

    checkUpdates(pi).then((results) => {
      if (results.length === 0) return;
      const count = results.length;
      const line = `📦 ${count} package${count > 1 ? 's have' : ' has'} updates — run /update-summary for changelogs`;
      ctx.ui.notify(line, "info");
    }).catch(() => {});
  });

  // The injected prompt is mostly paths, so the transcript shows a compact line per package and
  // expands to the file list.
  pi.registerMessageRenderer<ChangelogStore>("update-summary", (message, { expanded, outputPad }, theme) => {
    const store = message.details;
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    const lines = [theme.fg("accent", `📦 Changelogs written to ${store?.dir ?? "disk"}`)];

    for (const pkg of store?.packages ?? []) {
      lines.push(`${pkg.displayName} ${pkg.currentVersion} → ${pkg.latestVersion}`);
      if (!expanded) continue;
      if (pkg.sources.length === 0) lines.push(theme.fg("dim", "  no changelog source fetched"));
      for (const source of pkg.sources) lines.push(theme.fg("dim", `  ${source.path}`));
    }

    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.registerCommand("update-summary", {
    description: "Fetch changelogs to local files and ask the model to summarize them",
    handler: async (args, ctx) => {
      // The first summary run of a fresh session names it so it is easy to find later.
      if (pi.getSessionName() === undefined && !ctx.sessionManager.getEntries().some((e) => e.type === "message")) {
        pi.setSessionName(summarySessionName(new Date()));
      }
      const target = args.trim();
      ctx.ui.notify(target ? `Fetching changelog for ${target}…` : "Checking installed packages for updates…", "info");

      const summaries = target ? await collectTargetSummary(target) : await collectUpdateSummaries();

      if (summaries.length === 0) {
        ctx.ui.notify(target ? `No changelog found for ${target}` : "No package updates available", "warning");
        return;
      }

      let store: ChangelogStore;
      try {
        store = await writeChangelogFiles(summaries);
      } catch (err) {
        ctx.ui.notify(`Could not write changelog files: ${(err as Error).message}`, "error");
        return;
      }

      // The full text lives on disk, so only paths and metadata are injected. The message is
      // visible: the user sees where the files went, and details drive the compact renderer.
      pi.sendMessage(
        {
          customType: "update-summary",
          content: buildSummaryPrompt(store),
          display: true,
          details: store,
        },
        { triggerTurn: true },
      );
    },
  });

  if (toolConfig.warning) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(toolConfig.warning!, "warning");
    });
  }

  // Registering nothing keeps the tool out of the model's request entirely; /update-summary covers the same ground.
  if (!toolConfig.registerTool) return;

  pi.registerTool({
    name: "package_changelog",
    label: "Package Changelog",
    description: "Fetch changelog and release notes for an npm package or GitHub repository. Shows version history and recent changes.",
    promptSnippet: "Check package changelog or release notes",
    promptGuidelines: ["Use package_changelog when the user asks what changed in a pi extension package or npm package."],
    parameters: Type.Object({
      package: Type.String({ description: "npm package name (e.g. 'pi-ask-user') or GitHub repo path (e.g. 'user/repo')" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { package: packageName } = params;

      if (isGithubRepoPath(packageName)) {
        const releases = await fetchGitHubReleases(packageName);
        if (releases) {
          return {
            content: [{ type: "text", text: `## ${packageName} — Recent Releases\n\n${releases}` }],
            details: { type: "github", owner: packageName.split("/")[0], repo: packageName.split("/")[1] },
          };
        }
        return {
          content: [{ type: "text", text: `No releases found for ${packageName}` }],
          details: { type: "github", owner: packageName.split("/")[0], repo: packageName.split("/")[1] },
        };
      }

      const agentDir = getAgentDir();
      const latestVersion = (await getLatestNpmVersion(packageName)) ?? "unknown";
      const installedVersion = await getInstalledVersion(packageName, agentDir);

      const { changelog, repoUrl } = await fetchNpmChangelog(
        packageName,
        latestVersion !== "unknown" ? latestVersion : "latest"
      );

      let text = `## ${packageName}\n`;
      text += `Installed: ${installedVersion ?? "not installed"} | Latest: ${latestVersion}\n`;
      if (repoUrl) text += `Repository: ${repoUrl}\n\n`;

      if (changelog) {
        text += changelog.slice(0, 3000);
      } else {
        text += "No changelog available. ";
        if (repoUrl) text += `Check the repository: ${repoUrl}`;
        else text += "Try searching npm or GitHub directly.";
      }

      return {
        content: [{ type: "text", text }],
        details: { type: "npm", name: packageName, installed: installedVersion, latest: latestVersion },
      };
    },
  });
}