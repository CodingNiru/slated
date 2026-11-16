const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeCanvasAssignment,
  summarizeAnnouncementServer,
  stripHtmlServer,
  getCuratedCourseResources,
  CONDER_PACING_CALENDAR,
} = require('./server.js');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function encryptSnapshotWithToken(token, payloadObj) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(token.trim(), salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);
  return `${salt.toString('base64')}.${iv.toString('base64')}.${combined.toString('base64')}`;
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>+~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function cleanJs(js) {
  const lines = js.split('\n');
  let inBlockComment = false;
  const cleanLines = [];
  for (const l of lines) {
    const trimmed = l.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || (trimmed.startsWith('/*') && trimmed.endsWith('*/'))) {
      continue;
    }
    if (trimmed.length === 0) continue;
    cleanLines.push(trimmed);
  }
  return cleanLines.join('\n');
}

async function buildBundle() {
  const includeSnapshot = process.env.BUILD_CANVAS_SNAPSHOT === 'true';
  const baseUrl = (process.env.CANVAS_BASE_URL || 'https://wcpss.instructure.com')
    .trim()
    .replace(/^(https?):\/([^/])/i, '$1://$2')
    .replace(/\/+$/, '');
  const token = includeSnapshot ? (process.env.CANVAS_API_TOKEN || '').trim() : '';

  let encryptedSnapshotScript = '';

  if (includeSnapshot && !token) {
    throw new Error('CANVAS_API_TOKEN is required when BUILD_CANVAS_SNAPSHOT=true.');
  }

  if (includeSnapshot) {
    try {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      const [userRes, coursesRes, eventsRes] = await Promise.all([
        fetch(`${baseUrl}/api/v1/users/self`, { headers }),
        fetch(
          `${baseUrl}/api/v1/courses?enrollment_state=active&include[]=term&include[]=favorites&include[]=teachers&include[]=sections&include[]=total_scores&include[]=syllabus_body&per_page=50`,
          { headers }
        ),
        fetch(`${baseUrl}/api/v1/users/self/upcoming_events`, { headers }),
      ]);

      const userProfile = userRes.ok ? await userRes.json() : {};
      const rawCourses = coursesRes.ok ? await coursesRes.json() : [];
      const courses = Array.isArray(rawCourses)
        ? rawCourses.filter((c) => c && c.name && !c.access_restricted_by_date)
        : [];
      const upcomingEvents = eventsRes.ok ? await eventsRes.json() : [];

      const courseContexts = {};
      const assignmentMap = new Map();

      await Promise.all(
        courses.slice(0, 10).map(async (c) => {
          const [assignList, groupList, moduleList] = await Promise.all([
            fetch(
              `${baseUrl}/api/v1/courses/${c.id}/assignments?per_page=100&order_by=due_at&include[]=submission`,
              { headers }
            )
              .then((r) => r.json())
              .catch(() => []),
            fetch(`${baseUrl}/api/v1/courses/${c.id}/assignment_groups?per_page=50`, { headers })
              .then((r) => r.json())
              .catch(() => []),
            fetch(`${baseUrl}/api/v1/courses/${c.id}/modules?include[]=items&per_page=50`, {
              headers,
            })
              .then((r) => r.json())
              .catch(() => []),
          ]);

          const groupMap = new Map();
          if (Array.isArray(groupList)) {
            for (const g of groupList) {
              if (g && g.id && g.name) {
                groupMap.set(String(g.id), g.name);
              }
            }
          }

          courseContexts[String(c.id)] = {
            modules: Array.isArray(moduleList)
              ? moduleList.slice(0, 6).map((m) => ({
                  id: m.id,
                  name: m.name,
                  state: m.state || null,
                  items_count: m.items_count || (Array.isArray(m.items) ? m.items.length : 0),
                  items: Array.isArray(m.items)
                    ? m.items.slice(0, 4).map((it) => ({
                        id: it.id,
                        title: it.title,
                        type: it.type,
                        html_url: it.html_url || it.url || '',
                      }))
                    : [],
                }))
              : [],
            groups: Array.isArray(groupList)
              ? groupList.map((g) => ({
                  id: g.id,
                  name: g.name,
                  group_weight: g.group_weight || 0,
                  rules: g.rules || {},
                }))
              : [],
          };

          if (Array.isArray(assignList)) {
            for (const rawItem of assignList) {
              const item = normalizeCanvasAssignment(rawItem, groupMap);
              if (item && item.id) assignmentMap.set(String(item.id), item);
            }
          }
        })
      );

      if (Array.isArray(upcomingEvents)) {
        for (const ev of upcomingEvents) {
          if (ev.assignment) {
            const item = normalizeCanvasAssignment(ev.assignment);
            if (item && item.id && !assignmentMap.has(String(item.id))) {
              assignmentMap.set(String(item.id), item);
            }
          }
        }
      }

      let announcements = [];
      if (courses.length > 0) {
        const ctx = courses
          .slice(0, 10)
          .map((c) => `context_codes[]=course_${c.id}`)
          .join('&');
        const annRes = await fetch(
          `${baseUrl}/api/v1/announcements?${ctx}&start_date=2025-08-01&end_date=2027-07-01&per_page=50`,
          { headers }
        ).catch(() => null);
        if (annRes && annRes.ok) {
          const data = await annRes.json();
          if (Array.isArray(data)) {
            announcements = data.map(summarizeAnnouncementServer);
          }
        }
      }

      // Curate announcements: keep top 16, discard bloated raw HTML 'message', keep clean_text
      const curatedAnnouncements = announcements
        .slice(0, 16)
        .map((ann) => ({
          id: ann.id,
          title: ann.title,
          clean_text: (ann.clean_text || stripHtmlServer(ann.message || '')).slice(0, 260),
          posted_at: ann.posted_at,
          context_code: ann.context_code,
          author_name: ann.author_name || 'Instructor',
          read_state: ann.read_state || 'read',
          html_url: ann.html_url || '',
          category: ann.category || 'Class Update',
          tldr: ann.tldr || '',
          bullets: Array.isArray(ann.bullets) ? ann.bullets.slice(0, 4) : [],
          attachments: Array.isArray(ann.attachments) ? ann.attachments.slice(0, 3) : [],
        }));

      // Curate assignments: strip descriptions and attachments on older completed work
      const nowMs = Date.now();
      const curatedAssignments = Array.from(assignmentMap.values()).map((a) => {
        const dueMs = a.due_at ? new Date(a.due_at).getTime() : 0;
        const isOldCompleted =
          (a.is_submitted || a.score != null) &&
          dueMs > 0 &&
          nowMs - dueMs > 25 * 86400 * 1000;

        return {
          id: a.id,
          course_id: a.course_id,
          name: a.name,
          due_at: a.due_at,
          created_at: a.created_at,
          points_possible: a.points_possible,
          assignment_group_id: a.assignment_group_id,
          group_name: a.group_name,
          html_url: a.html_url,
          description: isOldCompleted ? '' : stripHtmlServer(a.description || '').slice(0, 140),
          attachments: isOldCompleted ? [] : (a.attachments || []).slice(0, 2),
          submission_types: a.submission_types,
          no_online_submission: a.no_online_submission,
          is_submitted: a.is_submitted,
          submission_status: a.submission_status,
          score: a.score,
          grade: a.grade,
          late: a.late,
          missing: a.missing,
          excused: a.excused,
          rubric: a.rubric ? a.rubric.slice(0, 3) : null,
        };
      });

      const snapshotPayload = {
        studentName: userProfile.short_name || userProfile.name || 'Student',
        courses: courses.map((c) => ({
          id: c.id,
          name: c.name,
          course_code: c.course_code,
          html_url: c.html_url || `${baseUrl}/courses/${c.id}`,
          calendar: c.calendar,
          term: c.term,
          teachers: c.teachers,
          sections: c.sections || [],
          syllabus_summary: c.syllabus_body ? stripHtmlServer(c.syllabus_body).slice(0, 150) : '',
        })),
        courseContexts,
        assignments: curatedAssignments,
        announcements: curatedAnnouncements,
        resources: getCuratedCourseResources(baseUrl),
        pacingCalendar: CONDER_PACING_CALENDAR,
      };

      const encryptedBundle = encryptSnapshotWithToken(token, snapshotPayload);
      encryptedSnapshotScript = `<script id="slated-snapshot">window.__ENCRYPTED_CANVAS_SNAPSHOT__="${encryptedBundle}";</script>\n`;
      console.log(
        `Encrypted curated snapshot (${snapshotPayload.courses.length} courses, ${snapshotPayload.assignments.length} assignments, ${snapshotPayload.announcements.length} announcements) with PBKDF2-SHA256 + AES-256-GCM.`
      );
    } catch (err) {
      console.error('Could not build the requested Canvas snapshot:', err.message);
      throw err;
    }
  }

  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  let html = fs.readFileSync(path.join(__dirname, 'src', 'site-shell.html'), 'utf8');
  const tailwindCss = fs.readFileSync(path.join(__dirname, 'public', 'tailwind.generated.css'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

  const minifiedCss = `${tailwindCss}\n${minifyCss(css)}`;
  const cleanedJs = cleanJs(js);

  html = html.replace('<link rel="stylesheet" href="/tailwind.generated.css" />', '');
  html = html.replace('<link rel="stylesheet" href="/styles.css" />', () => `<style>\n${minifiedCss}\n</style>`);
  html = html.replace(
    '<script src="/app.js"></script>',
    () => `${encryptedSnapshotScript}<script>\n${cleanedJs}\n</script>`
  );

  if (
    (token && html.includes(token)) ||
    html.includes('WHXn29Aw6ykK77ZR') ||
    html.includes('Columbian Exchange Posterboard')
  ) {
    throw new Error('SECURITY ABORT: Plaintext token or course data detected in static bundle.');
  }

  const outPath = path.join(distDir, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');
  fs.copyFileSync(
    path.join(__dirname, 'public', 'manifest.json'),
    path.join(distDir, 'manifest.json')
  );
  console.log(`Built verified zero-plaintext bundle at ${outPath} (${fs.statSync(outPath).size} bytes)`);
}

module.exports = { buildBundle, parseEnvFile };

if (require.main === module) {
  buildBundle();
}
