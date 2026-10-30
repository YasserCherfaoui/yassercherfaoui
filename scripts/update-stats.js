const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("Missing STATS_TOKEN or GITHUB_TOKEN");
  process.exit(1);
}

// 35 bytes of code per line is the standard industry ratio for mixed languages
const BYTES_PER_LINE = 35;

async function fetchAllRepos() {
  let hasNext = true;
  let cursor = null;
  let allRepos = [];

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `
      query {
        viewer {
          repositories(first: 100, isFork: false, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]${afterClause}) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              name
              isPrivate
              languages(first: 20, orderBy: {field: SIZE, direction: DESC}) {
                edges {
                  size
                  node {
                    name
                    color
                  }
                }
              }
            }
          }
        }
      }
    `;

    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Yasser-Stats-Bot"
      },
      body: JSON.stringify({ query })
    });

    const json = await res.json();
    if (json.errors) {
      throw new Error(JSON.stringify(json.errors));
    }

    const reposData = json.data.viewer.repositories;
    allRepos.push(...reposData.nodes);
    hasNext = reposData.pageInfo.hasNextPage;
    cursor = reposData.pageInfo.endCursor;
  }

  return allRepos;
}

function renderBar(pct, width = 20) {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatShortNum(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return Math.round(num / 1000) + 'k';
  }
  return String(num);
}

async function run() {
  console.log("Fetching repositories...");
  const repos = await fetchAllRepos();
  console.log(`Analyzed ${repos.length} non-fork repositories.`);

  const langMap = {};
  let totalBytes = 0;

  for (const r of repos) {
    if (!r.languages?.edges) continue;
    for (const e of r.languages.edges) {
      const name = e.node.name;
      langMap[name] = (langMap[name] || 0) + e.size;
      totalBytes += e.size;
    }
  }

  const totalLines = Math.round(totalBytes / BYTES_PER_LINE);

  const topLanguages = Object.entries(langMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, bytes]) => {
      const lines = Math.round(bytes / BYTES_PER_LINE);
      const percentage = Number(((bytes / totalBytes) * 100).toFixed(1));
      return { name, bytes, lines, percentage };
    });

  // Highlight specific languages for portfolio cards
  const getLangLines = (name) => {
    const item = topLanguages.find(l => l.name.toLowerCase() === name.toLowerCase());
    return item ? formatShortNum(item.lines) : '0';
  };

  const highlights = {
    go: getLangLines('Go'),
    typescript: getLangLines('TypeScript'),
    dart: getLangLines('Dart'),
    javascript: getLangLines('JavaScript'),
    python: getLangLines('Python')
  };

  // 1. Output stats.json for portfolio website
  const statsPayload = {
    updatedAt: new Date().toISOString(),
    totalLines,
    repoCount: repos.length,
    languages: topLanguages,
    highlights
  };

  fs.writeFileSync('stats.json', JSON.stringify(statsPayload, null, 2));
  console.log("Wrote stats.json successfully.");

  // 2. Format Markdown for readme.md
  const langRows = topLanguages.map(l => {
    const bar = renderBar(l.percentage, 20);
    const lineStr = l.lines.toLocaleString().padStart(9, ' ');
    const pctStr = (l.percentage.toFixed(1) + '%').padStart(6, ' ');
    return `${l.name.padEnd(12, ' ')} ${bar} ${pctStr}  (${lineStr} lines)`;
  }).join('\n');

  const statsMarkdown = `<!-- START_SECTION:loc_stats -->
\`\`\`text
Lines of Code:    ${totalLines.toLocaleString()} LOC
Repositories:     ${repos.length} (Public & Private)
Last Updated:     ${new Date().toISOString().split('T')[0]}

${langRows}
\`\`\`
<!-- END_SECTION:loc_stats -->`;

  // 3. Update readme.md
  const readmePath = 'readme.md';
  if (fs.existsSync(readmePath)) {
    let content = fs.readFileSync(readmePath, 'utf8');
    const regex = /<!-- START_SECTION:loc_stats -->[\s\S]*?<!-- END_SECTION:loc_stats -->/;
    if (regex.test(content)) {
      content = content.replace(regex, statsMarkdown);
      fs.writeFileSync(readmePath, content);
      console.log("Updated readme.md with live stats!");
    } else {
      console.warn("Markers <!-- START_SECTION:loc_stats --> not found in readme.md; inserting before Activity Snake.");
      if (content.includes('### 🐍 Activity Snake')) {
        content = content.replace('### 🐍 Activity Snake', `### 📊 Lines of Code Breakdown (Live)\n\n${statsMarkdown}\n\n---\n\n### 🐍 Activity Snake`);
      } else {
        content += `\n\n### 📊 Lines of Code Breakdown (Live)\n\n${statsMarkdown}\n`;
      }
      fs.writeFileSync(readmePath, content);
    }
  }
}

run().catch(err => {
  console.error("Error updating stats:", err);
  process.exit(1);
});
