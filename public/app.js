(() => {
  let browserStorageIssueReported = false;

  function reportBrowserStorageIssue(error) {
    if (browserStorageIssueReported) return;
    browserStorageIssueReported = true;
    console.warn('Browser storage is unavailable or contains invalid data:', error);
    const notify = () => showToast('Browser storage is unavailable; some changes may not persist.', 5000);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', notify, { once: true });
    } else {
      setTimeout(notify, 0);
    }
  }

  function getStoredItem(storageName, key) {
    try {
      return window[storageName].getItem(key);
    } catch (error) {
      reportBrowserStorageIssue(error);
      return null;
    }
  }

  function setStoredItem(storageName, key, value) {
    try {
      window[storageName].setItem(key, value);
      return true;
    } catch (error) {
      reportBrowserStorageIssue(error);
      return false;
    }
  }

  function removeStoredItem(storageName, key) {
    try {
      window[storageName].removeItem(key);
      return true;
    } catch (error) {
      reportBrowserStorageIssue(error);
      return false;
    }
  }

  function readStoredJson(key, fallback, isValid) {
    const raw = getStoredItem('localStorage', key);
    if (raw === null) return fallback;
    try {
      const value = JSON.parse(raw);
      if (!isValid(value)) throw new TypeError(`Invalid stored value for ${key}.`);
      return value;
    } catch (error) {
      reportBrowserStorageIssue(error);
      removeStoredItem('localStorage', key);
      return fallback;
    }
  }

  let unsafeUrlReported = false;
  function safeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, window.location.href);
      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username ||
        url.password
      ) {
        if (!unsafeUrlReported) {
          unsafeUrlReported = true;
          console.warn('An unsafe external URL was omitted.');
        }
        return null;
      }
      return url.href;
    } catch (error) {
      if (!unsafeUrlReported) {
        unsafeUrlReported = true;
        console.warn('An invalid external URL was omitted:', error.message);
      }
      return null;
    }
  }

  const localDateKey = (date = new Date()) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  const state = {
    apiOrigin: '',
    cloudStaticMode: false,
    authenticated: false,
    isDemoMode: false,
    user: null,
    hasLocalEnvFileToken: false,
    credentials: {
      configured: false,
      canvasBaseUrl: 'https://wcpss.instructure.com',
      maskedToken: null,
    },
    canvasBaseUrl: 'https://wcpss.instructure.com',
    courses: [],
    assignments: [],
    announcements: [],
    courseContexts: {},
    whatIfScores: {},
    whatIfCustomTests: {},
    targetGradeInputs: {}, // courseId -> { targetPercent: 90, nextTestPoints: 100 }
    customTasks: readStoredJson('atelier_custom_tasks', [], Array.isArray),
    checkedIds: new Set(readStoredJson('atelier_checked_ids', [], Array.isArray)),
    inClassRetakeIds: new Set(readStoredJson('slated_inclass_retakes', [], Array.isArray)),
    packedSupplyIds: new Set(readStoredJson('slated_packed_supplies', [], Array.isArray)),
    savedBriefingIds: new Set(
      readStoredJson('atelier_saved_briefings', [], (value) => value === null || Array.isArray(value)) || []
    ),
    savedBriefingsInitialized: Boolean(getStoredItem('localStorage', 'atelier_saved_briefings')),
    expandedAnnouncementIds: new Set(),
    securityAuditLog: [],
    selectedCourseId: 'all',
    assignmentHorizon: 'all',
    collapsedBuckets: new Set(['completed', 'archived']),
    cmdPaletteSelectedIndex: 0,
    briefingTab: 'all',
    briefingPage: 1,
    briefingsPerPage: 8,
    resourcePage: 1,
    resourcesPage: 1,
    resourcesPerPage: 9,
    announcementFilter: 'all',
    inspectorCourseId: null,
    inspectorTab: 'overview',
    searchQuery: '',
    calendarDate: new Date(),
    palette: getStoredItem('localStorage', 'slated_palette') || 'obsidian',
    studyLab: {
      activeDeck: 'calc_log',
      activeProblemIdx: 0,
      inputMode: 'type', // 'type' | 'draw' | 'upload'
      typedInput: '',
      customTargetExpr: '(x^2+1)^sin(x) * (cos(x)*ln(x^2+1) + (2*x*sin(x))/(x^2+1))',
      customOrigYExpr: '(x^2+1)^sin(x)',
      showSteps: false,
      lastVerification: null,
      uploadedImageMeta: null,
      uploadedImageDataUrl: null,
      scratchpadStrokes: [],
      penColor: '#ff4f00',
    },
    focusTimer: {
      active: false,
      paused: false,
      secondsLeft: 25 * 60,
      label: 'Study Session',
      intervalId: null,
    },
    soundMuted: getStoredItem('localStorage', 'slated_sound_muted') === 'true',
    compactView: getStoredItem('localStorage', 'slated_compact_view') === 'true',
    resourceSearch: '',
    resourceClassFilter: 'all',
    resourceCategoryFilter: 'all',
    announcementSearch: '',
    pinnedAnnouncementIds: new Set(
      readStoredJson('slated_pinned_announcements', [], Array.isArray)
    ),
    resources: [],
    pacingCalendar: null,
  };

  let browserRamCreds = null;
  let unlockedSnapshotData = null;

  const els = {
    html: document.documentElement,
    sectionNavLinks: document.getElementById('sectionNavLinks'),
    canvasInstanceLink: document.getElementById('canvasInstanceLink'),
    syncStatusText: document.getElementById('syncStatusText'),
    gameplanStrip: document.getElementById('gameplanStrip'),
    bellScheduleStrip: document.getElementById('bellScheduleStrip'),
    studyDeckSidebar: document.getElementById('studyDeckSidebar'),
    studyVerifierWorkspace: document.getElementById('studyVerifierWorkspace'),

    focusTimerBar: document.getElementById('focusTimerBar'),
    focusTimerLabel: document.getElementById('focusTimerLabel'),
    focusTimerClock: document.getElementById('focusTimerClock'),
    focusTimerToggleBtn: document.getElementById('focusTimerToggleBtn'),
    focusTimerStopBtn: document.getElementById('focusTimerStopBtn'),
    startQuickFocusBtn: document.getElementById('startQuickFocusBtn'),

    openCmdPaletteBtn: document.getElementById('openCmdPaletteBtn'),
    cmdPaletteBackdrop: document.getElementById('cmdPaletteBackdrop'),
    cmdPaletteInput: document.getElementById('cmdPaletteInput'),
    closeCmdPaletteBtn: document.getElementById('closeCmdPaletteBtn'),
    cmdPaletteResults: document.getElementById('cmdPaletteResults'),
    footerCmdBtn: document.getElementById('footerCmdBtn'),

    openPrivacyModalBtn: document.getElementById('openPrivacyModalBtn'),
    heroInspectSecurityBtn: document.getElementById('heroInspectSecurityBtn'),
    footerSecurityBtn: document.getElementById('footerSecurityBtn'),
    privacyModalBackdrop: document.getElementById('privacyModalBackdrop'),
    closePrivacyModalBtn: document.getElementById('closePrivacyModalBtn'),
    donePrivacyModalBtn: document.getElementById('donePrivacyModalBtn'),
    securityAuditLogBox: document.getElementById('securityAuditLogBox'),
    auditLogCountBadge: document.getElementById('auditLogCountBadge'),
    panicWipeBtn: document.getElementById('panicWipeBtn'),

    openBriefingsDrawerBtn: document.getElementById('openBriefingsDrawerBtn'),
    savedBriefingsCountBadge: document.getElementById('savedBriefingsCountBadge'),
    briefingsDrawerBackdrop: document.getElementById('briefingsDrawerBackdrop'),
    closeBriefingsDrawerBtn: document.getElementById('closeBriefingsDrawerBtn'),
    savedBriefingsList: document.getElementById('savedBriefingsList'),

    courseInspectorBackdrop: document.getElementById('courseInspectorBackdrop'),
    closeCourseInspectorBtn: document.getElementById('closeCourseInspectorBtn'),
    inspectorCoursePeriod: document.getElementById('inspectorCoursePeriod'),
    inspectorCourseTitle: document.getElementById('inspectorCourseTitle'),
    inspectorCourseMeta: document.getElementById('inspectorCourseMeta'),
    courseInspectorBody: document.getElementById('courseInspectorBody'),

    openTokenModalBtn: document.getElementById('openTokenModalBtn'),
    copyIcalBtn: document.getElementById('copyIcalBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    userProfileBar: document.getElementById('userProfileBar'),
    userEmailBadge: document.getElementById('userEmailBadge'),
    logoutBtn: document.getElementById('logoutBtn'),

    authGateSection: document.getElementById('authGateSection'),
    dashboardMain: document.getElementById('dashboardMain'),

    savedGoogleAccountBox: document.getElementById('savedGoogleAccountBox'),
    savedGoogleAvatar: document.getElementById('savedGoogleAvatar'),
    savedGoogleName: document.getElementById('savedGoogleName'),
    savedGoogleEmail: document.getElementById('savedGoogleEmail'),
    continueSavedGoogleBtn: document.getElementById('continueSavedGoogleBtn'),
    continueGoogleFirstName: document.getElementById('continueGoogleFirstName'),
    googleSignInTriggerBtn: document.getElementById('googleSignInTriggerBtn'),
    googleBtnLabel: document.getElementById('googleBtnLabel'),
    googleIdentityDrawer: document.getElementById('googleIdentityDrawer'),
    googleEmailInput: document.getElementById('googleEmailInput'),
    googleDisplayNameInput: document.getElementById('googleDisplayNameInput'),

    helperCanvasSettingsLink: document.getElementById('helperCanvasSettingsLink'),
    quickConnectForm: document.getElementById('quickConnectForm'),
    quickTokenInput: document.getElementById('quickTokenInput'),
    quickBaseUrlInput: document.getElementById('quickBaseUrlInput'),
    quickConnectError: document.getElementById('quickConnectError'),
    quickConnectSubmitBtn: document.getElementById('quickConnectSubmitBtn'),
    quickEnvFileInput: document.getElementById('quickEnvFileInput'),
    quickLocalEnvBtn: document.getElementById('quickLocalEnvBtn'),

    tokenModalBackdrop: document.getElementById('tokenModalBackdrop'),
    closeTokenModalBtn: document.getElementById('closeTokenModalBtn'),
    cancelTokenModalBtn: document.getElementById('cancelTokenModalBtn'),
    currentTokenStatusBox: document.getElementById('currentTokenStatusBox'),
    maskedTokenLabel: document.getElementById('maskedTokenLabel'),
    currentBaseUrlLabel: document.getElementById('currentBaseUrlLabel'),
    deleteTokenBtn: document.getElementById('deleteTokenBtn'),
    envFileInput: document.getElementById('envFileInput'),
    credentialsForm: document.getElementById('credentialsForm'),
    modalGoogleEmailInput: document.getElementById('modalGoogleEmailInput'),
    canvasBaseUrlInput: document.getElementById('canvasBaseUrlInput'),
    canvasApiTokenInput: document.getElementById('canvasApiTokenInput'),
    tokenFormError: document.getElementById('tokenFormError'),
    saveTokenSubmitBtn: document.getElementById('saveTokenSubmitBtn'),

    searchInput: document.getElementById('searchInput'),
    courseFilterSelect: document.getElementById('courseFilterSelect'),
    resetCourseFilterBtn: document.getElementById('resetCourseFilterBtn'),
    toastBanner: document.getElementById('toastBanner'),
    toastMessage: document.getElementById('toastMessage'),
    statActiveCourses: document.getElementById('statActiveCourses'),
    statUrgentAssignments: document.getElementById('statUrgentAssignments'),
    statWeekAssignments: document.getElementById('statWeekAssignments'),
    statDoneAssignments: document.getElementById('statDoneAssignments'),

    countUpcomingBadge: document.getElementById('countUpcomingBadge'),
    countUrgentBadge: document.getElementById('countUrgentBadge'),
    countWeekBadge: document.getElementById('countWeekBadge'),
    countTodoBadge: document.getElementById('countTodoBadge'),
    countCompletedBadge: document.getElementById('countCompletedBadge'),
    countAllBadge: document.getElementById('countAllBadge'),

    customTaskForm: document.getElementById('customTaskForm'),
    customTaskTitle: document.getElementById('customTaskTitle'),
    customTaskCourse: document.getElementById('customTaskCourse'),
    customTaskDue: document.getElementById('customTaskDue'),

    courseCardsGrid: document.getElementById('courseCardsGrid'),
    assignmentsList: document.getElementById('assignmentsList'),
    announcementsList: document.getElementById('announcementsList'),
    calendarMonthLabel: document.getElementById('calendarMonthLabel'),
    calendarGrid: document.getElementById('calendarGrid'),
    prevMonthBtn: document.getElementById('prevMonthBtn'),
    nextMonthBtn: document.getElementById('nextMonthBtn'),
    todayMonthBtn: document.getElementById('todayMonthBtn'),

    cmdPaletteKeyBadge: document.getElementById('cmdPaletteKeyBadge'),
    cmdPaletteMatchCount: document.getElementById('cmdPaletteMatchCount'),
    openGcalSyncBtn: document.getElementById('openGcalSyncBtn'),
    downloadIcsBtn: document.getElementById('downloadIcsBtn'),
    gcalSyncModalBackdrop: document.getElementById('gcalSyncModalBackdrop'),
    closeGcalSyncModalBtn: document.getElementById('closeGcalSyncModalBtn'),
    gcalWebSyncBtn: document.getElementById('gcalWebSyncBtn'),
    gcalDownloadIcsBtn: document.getElementById('gcalDownloadIcsBtn'),
    gcalFeedUrlInput: document.getElementById('gcalFeedUrlInput'),
    gcalCopyFeedBtn: document.getElementById('gcalCopyFeedBtn'),

    // Drawers & Nav Buttons
    studyLabDrawerBackdrop: document.getElementById('studyLabDrawerBackdrop'),
    closeStudyLabDrawerBtn: document.getElementById('closeStudyLabDrawerBtn'),
    resourcesDrawerBackdrop: document.getElementById('resourcesDrawerBackdrop'),
    closeResourcesDrawerBtn: document.getElementById('closeResourcesDrawerBtn'),
    pacingDrawerBackdrop: document.getElementById('pacingDrawerBackdrop'),
    closePacingDrawerBtn: document.getElementById('closePacingDrawerBtn'),
    calendarDrawerBackdrop: document.getElementById('calendarDrawerBackdrop'),
    closeCalendarDrawerBtn: document.getElementById('closeCalendarDrawerBtn'),
    drawerDownloadIcsBtn: document.getElementById('drawerDownloadIcsBtn'),

    navStudyLabBtn: document.getElementById('navStudyLabBtn'),
    navBriefingsBtn: document.getElementById('navBriefingsBtn'),
    navResourcesBtn: document.getElementById('navResourcesBtn'),
    navPacingBtn: document.getElementById('navPacingBtn'),
    navCalendarBtn: document.getElementById('navCalendarBtn'),

    hubOpenStudyLabBtn: document.getElementById('hubOpenStudyLabBtn'),
    hubOpenBriefingsBtn: document.getElementById('hubOpenBriefingsBtn'),
    hubOpenResourcesBtn: document.getElementById('hubOpenResourcesBtn'),
    hubOpenPacingBtn: document.getElementById('hubOpenPacingBtn'),
    hubBriefingCountBadge: document.getElementById('hubBriefingCountBadge'),
    hubResourceCountBadge: document.getElementById('hubResourceCountBadge'),
    hubPacingMilestoneBadge: document.getElementById('hubPacingMilestoneBadge'),

    briefingTabAllBtn: document.getElementById('briefingTabAllBtn'),
    briefingTabSavedBtn: document.getElementById('briefingTabSavedBtn'),
    briefingsAllView: document.getElementById('briefingsAllView'),
    briefingsSavedView: document.getElementById('briefingsSavedView'),
    savedBriefingsDrawerBadge: document.getElementById('savedBriefingsDrawerBadge'),
    annPaginationBar: document.getElementById('annPaginationBar'),
    resourcesPaginationBar: document.getElementById('resourcesPaginationBar'),

    submissionModalBackdrop: document.getElementById('submissionModalBackdrop'),
    closeSubmissionModalBtn: document.getElementById('closeSubmissionModalBtn'),
    submitCourseBadge: document.getElementById('submitCourseBadge'),
    submitPointsBadge: document.getElementById('submitPointsBadge'),
    submitAssignmentTitle: document.getElementById('submitAssignmentTitle'),
    submitDueBadge: document.getElementById('submitDueBadge'),
    submitTabUrlBtn: document.getElementById('submitTabUrlBtn'),
    submitTabFileBtn: document.getElementById('submitTabFileBtn'),
    submitTabTextBtn: document.getElementById('submitTabTextBtn'),
    submissionUrlForm: document.getElementById('submissionUrlForm'),
    submissionUrlInput: document.getElementById('submissionUrlInput'),
    submissionSubmitBtn: document.getElementById('submissionSubmitBtn'),
    submissionErrorNotice: document.getElementById('submissionErrorNotice'),
    submissionCanvasDirectLink: document.getElementById('submissionCanvasDirectLink'),
    submissionFileForm: document.getElementById('submissionFileForm'),
    submissionFileInput: document.getElementById('submissionFileInput'),
    submissionFileSubmitBtn: document.getElementById('submissionFileSubmitBtn'),
    submissionFileErrorNotice: document.getElementById('submissionFileErrorNotice'),
    submissionCanvasDirectLink2: document.getElementById('submissionCanvasDirectLink2'),
    submissionTextForm: document.getElementById('submissionTextForm'),
    submissionTextInput: document.getElementById('submissionTextInput'),
    submissionTextSubmitBtn: document.getElementById('submissionTextSubmitBtn'),
    submissionTextErrorNotice: document.getElementById('submissionTextErrorNotice'),
    submissionCanvasDirectLink3: document.getElementById('submissionCanvasDirectLink3'),

    offlineStatusBadge: document.getElementById('offlineStatusBadge'),
    soundToggleBtn: document.getElementById('soundToggleBtn'),
    soundToggleIcon: document.getElementById('soundToggleIcon'),
    compactViewToggleBtn: document.getElementById('compactViewToggleBtn'),
    printGameplanBtn: document.getElementById('printGameplanBtn'),
    annSearchInput: document.getElementById('annSearchInput'),
    annMatchCountBadge: document.getElementById('annMatchCountBadge'),
    resourcesGrid: document.getElementById('resourcesGrid'),
    resourceCountBadge: document.getElementById('resourceCountBadge'),
    resourceCategorySelect: document.getElementById('resourceCategorySelect'),
    resourceSearchInput: document.getElementById('resourceSearchInput'),
    pacingTimelineList: document.getElementById('pacingTimelineList'),
    pacingProgressBar: document.getElementById('pacingProgressBar'),
    pacingProgressText: document.getElementById('pacingProgressText'),
    syncPacingToGcalBtn: document.getElementById('syncPacingToGcalBtn'),
    downloadOfficialPdfCalendarBtn: document.getElementById('downloadOfficialPdfCalendarBtn'),
  };

  const CONDER_PACING_CALENDAR = {
  month: 'November 2026',
  course_id: '1414245',
  course_title: 'AP World History: Modern - Conder',
  pdf_download_url: 'https://wcpss.instructure.com/courses/1414245/files/120626470/download?verifier=e0b3aeb3-0bd3-4db2-8126-909d5758396c',
  pdf_filename: 'AP_World_November_Reading_Calendar.pdf',
  milestones: [
    { date: '2026-11-02', day_type: 'B Day', label: 'Quiz: Chapter 22', detail: 'Transoceanic Encounters & Global Connections', reading: 'Read Ch. 24, pp. 543–549', reading_chapter: 24, is_assessment: true },
    { date: '2026-11-03', day_type: 'No School', label: 'Teacher Workday — No School', detail: 'Campus closed for election / planning', reading: null, is_holiday: true },
    { date: '2026-11-04', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'Colonial Latin America & Encomienda Labor', reading: 'Read Ch. 24, pp. 550–557', reading_chapter: 24 },
    { date: '2026-11-05', day_type: 'B Day', label: 'Pre-SAT Testing / Class', detail: 'North American Settler Colonies', reading: 'Read Ch. 24, pp. 550–557', reading_chapter: 24 },
    { date: '2026-11-06', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'African States & Songhai Empire', reading: 'Read Ch. 25, pp. 562–568', reading_chapter: 25 },
    { date: '2026-11-09', day_type: 'B Day', label: 'Class Pacing Milestone', detail: 'Kingdom of Kongo & Atlantic Slave Trade', reading: 'Read Ch. 25, pp. 562–568', reading_chapter: 25 },
    { date: '2026-11-10', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'Middle Passage & Plantation Societies', reading: 'Read Ch. 25, pp. 569–575', reading_chapter: 25 },
    { date: '2026-11-11', day_type: 'No School', label: 'Veterans Day — No School', detail: 'National Holiday', reading: null, is_holiday: true },
    { date: '2026-11-12', day_type: 'B Day', label: 'Class Pacing Milestone', detail: 'African Diaspora & Resistance', reading: 'Read Ch. 25, pp. 569–575', reading_chapter: 25 },
    { date: '2026-11-13', day_type: 'A Day', label: 'Quiz: Chapter 24', detail: 'New Worlds: Americas & Oceania', reading: 'Read Ch. 25, pp. 576–582', reading_chapter: 25, is_assessment: true },
    { date: '2026-11-16', day_type: 'B Day', label: 'Quiz: Chapter 24', detail: 'New Worlds: Americas & Oceania', reading: 'Read Ch. 25, pp. 576–582', reading_chapter: 25, is_assessment: true },
    { date: '2026-11-17', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'Reformation & Sovereign States', reading: 'Read Ch. 23 (pp. 521–524) & Ch. 26 (pp. 593–594)', reading_chapter: 23 },
    { date: '2026-11-18', day_type: 'B Day', label: 'Class Pacing Milestone', detail: 'Reformation & Ming/Qing Governance', reading: 'Read Ch. 23 (pp. 521–524) & Ch. 26 (pp. 593–594)', reading_chapter: 23 },
    { date: '2026-11-19', day_type: 'A Day', label: 'Quiz: Chapter 25', detail: 'Africa & The Atlantic World', reading: 'Reread Ch. 22, pp. 499–503', reading_chapter: 22, is_assessment: true },
    { date: '2026-11-20', day_type: 'B Day', label: 'Quiz: Chapter 25', detail: 'Africa & The Atlantic World', reading: 'Reread Ch. 22, pp. 499–503', reading_chapter: 22, is_assessment: true },
    { date: '2026-11-23', day_type: 'A Day', label: 'Unit 4 Review Milestone', detail: 'Synthesize Columbian Exchange, Maritime Empires & Labor Systems', reading: 'Review Ch. 22/24/25 RTN notes' },
    { date: '2026-11-24', day_type: 'B Day', label: 'Unit 4 Review Milestone', detail: 'Synthesize Columbian Exchange, Maritime Empires & Labor Systems', reading: 'Review Ch. 22/24/25 RTN notes' },
    { date: '2026-11-25', day_type: 'No School', label: 'School Vacation — No School', detail: 'Thanksgiving Break', reading: null, is_holiday: true },
    { date: '2026-11-26', day_type: 'No School', label: 'Thanksgiving Day — No School', detail: 'Thanksgiving Holiday', reading: null, is_holiday: true },
    { date: '2026-11-27', day_type: 'No School', label: 'Holiday — No School', detail: 'Thanksgiving Break', reading: null, is_holiday: true },
    { date: '2026-11-30', day_type: 'A Day', label: 'UNIT 4 MAJOR ASSESSMENT (TEST)', detail: 'Transoceanic Connections (1450–1750) — Full Unit Exam', reading: 'Read Ch. 27, pp. 610–616', reading_chapter: 27, is_assessment: true, is_major: true }
  ]
};

const SAMPLE_STUDENT_DATA = {
  studentName: 'Alex Rivera (Demo)',
  courses: [
    {
      id: '101',
      name: 'P1 - AP Calculus BC - Martinez',
      course_code: 'AP-CALC-BC',
      teachers: [{ display_name: 'Maria Martinez' }],
      term: { name: 'Fall 2026' }
    },
    {
      id: '102',
      name: 'P2 - AP World History: Modern - Conder',
      course_code: 'AP-WHIST-MOD',
      teachers: [{ display_name: 'David Conder' }],
      term: { name: 'Fall 2026' }
    },
    {
      id: '103',
      name: 'P3 - AP Environmental Science - Henderson',
      course_code: 'AP-ENV-SCI',
      teachers: [{ display_name: 'Dr. Sarah Henderson' }],
      term: { name: 'Fall 2026' }
    },
    {
      id: '104',
      name: 'P4 - Honors English Literature - Thornton',
      course_code: 'HN-ENG-LIT',
      teachers: [{ display_name: 'Rachel Thornton' }],
      term: { name: 'Fall 2026' }
    }
  ],
  courseContexts: {
    '101': {
      groups: [
        { id: 'g101_1', name: 'Tests & Quizzes', group_weight: 70, rules: {} },
        { id: 'g101_2', name: 'Problem Sets & Homework', group_weight: 30, rules: {} }
      ],
      modules: [
        { id: 'm101', name: 'Unit 6: Advanced Techniques of Integration', items: [] }
      ]
    },
    '102': {
      groups: [
        { id: 'g102_1', name: 'Exams & DBQs', group_weight: 60, rules: {} },
        { id: 'g102_2', name: 'SAQs & Quizzes', group_weight: 25, rules: {} },
        { id: 'g102_3', name: 'Reading & Classwork', group_weight: 15, rules: {} }
      ],
      modules: [
        { id: 'm102', name: 'Unit 4: Transoceanic Interconnections (1450–1750)', items: [] }
      ]
    },
    '103': {
      groups: [
        { id: 'g103_1', name: 'Unit Exams & Practicals', group_weight: 50, rules: {} },
        { id: 'g103_2', name: 'Lab Reports & Field Data', group_weight: 30, rules: {} },
        { id: 'g103_3', name: 'Class Activities & Case Studies', group_weight: 20, rules: {} }
      ],
      modules: [
        { id: 'm103', name: 'Unit 4: Earth Systems & Resources', items: [] }
      ]
    },
    '104': {
      groups: [
        { id: 'g104_1', name: 'Major Essays & Projects', group_weight: 50, rules: {} },
        { id: 'g104_2', name: 'Close Readings & Quizzes', group_weight: 30, rules: {} },
        { id: 'g104_3', name: 'Socratic Discussions', group_weight: 20, rules: {} }
      ],
      modules: [
        { id: 'm104', name: 'Drama Analysis: Shakespeare & Modern Tragedies', items: [] }
      ]
    }
  },
  assignments: [
    {
      id: 'demo_1',
      course_id: '101',
      name: 'Unit 6 In-Class Test: Integration by Parts & Partial Fractions',
      due_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
      points_possible: 100,
      submission_types: ['on_paper'],
      description: 'Covers integration by parts, trigonometric substitutions, and partial fraction decomposition. No calculators allowed.',
      assignment_group_id: 'g101_1'
    },
    {
      id: 'demo_2',
      course_id: '101',
      name: 'Stewart Calc Sec 7.2 Practice #1–25 odd',
      due_at: new Date(Date.now() + 44 * 3600 * 1000).toISOString(),
      points_possible: 20,
      submission_types: ['online_upload'],
      description: 'Upload PDF scan of handwritten solutions for Sec 7.2 problems 1 through 25 odd.',
      assignment_group_id: 'g101_2'
    },
    {
      id: 'demo_3',
      course_id: '101',
      name: 'Sec 7.1 Integration Practice Worksheet',
      due_at: new Date(Date.now() - 3 * 86400 * 1000).toISOString(),
      points_possible: 15,
      submission_types: ['on_paper'],
      description: 'Handed in on paper during Period 1.',
      assignment_group_id: 'g101_2'
    },
    {
      id: 'demo_4',
      course_id: '101',
      name: 'Unit 5 Derivative Applications & Optimization Exam',
      due_at: new Date(Date.now() - 14 * 86400 * 1000).toISOString(),
      points_possible: 100,
      submission: { workflow_state: 'graded', score: 94 },
      assignment_group_id: 'g101_1'
    },
    {
      id: 'demo_5',
      course_id: '102',
      name: 'Traditions & Encounters Ch 24 Reading Guide & Key Terms',
      due_at: new Date(Date.now() + 3 * 86400 * 1000).toISOString(),
      points_possible: 25,
      submission_types: ['online_text_entry'],
      description: 'Answer reading guide questions for Chapter 24: New Worlds in the Americas and Oceania.',
      assignment_group_id: 'g102_3'
    },
    {
      id: 'demo_6',
      course_id: '102',
      name: 'SAQ Practice: Maritime Technology & Trading Post Empires',
      due_at: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
      points_possible: 30,
      submission_types: ['online_upload'],
      description: 'Write three-part SAQ responses analyzing Portuguese and Dutch trading post strategies.',
      assignment_group_id: 'g102_2'
    },
    {
      id: 'demo_7',
      course_id: '102',
      name: 'Aztec & Inca Civilization Comparison Posterboard',
      due_at: new Date(Date.now() - 4 * 86400 * 1000).toISOString(),
      points_possible: 25,
      submission_types: ['on_paper', 'none'],
      description: 'Group physical posterboard presentation completed during Period 2.',
      assignment_group_id: 'g102_3'
    },
    {
      id: 'demo_8',
      course_id: '102',
      name: 'Unit 3 Land-Based Empires DBQ',
      due_at: new Date(Date.now() - 18 * 86400 * 1000).toISOString(),
      points_possible: 100,
      submission: { workflow_state: 'graded', score: 91 },
      assignment_group_id: 'g102_1'
    },
    {
      id: 'demo_9',
      course_id: '103',
      name: 'Aquatic Biomes & Water Quality Titration Lab Report',
      due_at: new Date(Date.now() + 26 * 3600 * 1000).toISOString(),
      points_possible: 50,
      submission_types: ['online_upload'],
      description: 'Complete formal lab report including dissolved oxygen, pH, and nitrate concentration tables.',
      assignment_group_id: 'g103_2'
    },
    {
      id: 'demo_10',
      course_id: '103',
      name: 'Unit 4 Biogeochemical Cycles Quiz',
      due_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
      points_possible: 40,
      submission_types: ['on_paper'],
      description: 'In-class multiple choice and short answer quiz on nitrogen, carbon, and phosphorus cycles.',
      assignment_group_id: 'g103_1'
    },
    {
      id: 'demo_11',
      course_id: '103',
      name: 'Soil Core Sampling & Permeability Field Lab',
      due_at: new Date(Date.now() - 5 * 86400 * 1000).toISOString(),
      points_possible: 20,
      submission_types: ['none', 'on_paper'],
      description: 'Conducted in campus courtyard; data recorded on physical lab sheet.',
      assignment_group_id: 'g103_2'
    },
    {
      id: 'demo_12',
      course_id: '104',
      name: 'Hamlet Act III Scene 1 Soliloquy Close Reading & Thesis',
      due_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
      points_possible: 30,
      submission_types: ['online_text_entry'],
      description: 'Analyze Hamlet\'s "To be or not to be" soliloquy focusing on syntax and existential dread.',
      assignment_group_id: 'g104_2'
    },
    {
      id: 'demo_13',
      course_id: '104',
      name: 'The Lottery In-Class Socratic Seminar & Discussion',
      due_at: new Date(Date.now() - 6 * 86400 * 1000).toISOString(),
      points_possible: 20,
      submission_types: ['none'],
      description: 'Active participation in seminar on Jackson\'s The Lottery and mob mentality.',
      assignment_group_id: 'g104_3'
    }
  ],
  announcements: [
    {
      id: 'ann_demo_1',
      title: 'Unit 4 Exam Format & Study Guide Solution Key',
      context_code: 'course_102',
      posted_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      user_name: 'David Conder',
      message: '<p>Class, our Unit 4 Major Assessment is scheduled for next week. Study guide answer keys have been posted to the files section. Review Chapter 22 and 24 focus questions.</p>',
      clean_text: 'Class, our Unit 4 Major Assessment is scheduled for next week. Study guide answer keys have been posted to the files section. Review Chapter 22 and 24 focus questions.',
      executive_summary: {
        bottom_line: 'Unit 4 Major Assessment scheduled for next week; answer keys posted.',
        action_items: ['Download Chapter 22 & 24 study guide solution keys', 'Review maritime trading post notes'],
        quiz_alerts: ['Unit 4 Major Assessment next week']
      }
    },
    {
      id: 'ann_demo_2',
      title: 'Wednesday Office Hours & Formula Reference Sheet',
      context_code: 'course_101',
      posted_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      user_name: 'Maria Martinez',
      message: '<p>I will hold extra help after school on Wednesday from 2:30 to 3:30 PM in Room 214. Bring questions on integration by parts tabular method.</p>',
      clean_text: 'I will hold extra help after school on Wednesday from 2:30 to 3:30 PM in Room 214. Bring questions on integration by parts tabular method.',
      executive_summary: {
        bottom_line: 'Extra help Wednesday 2:30–3:30 PM in Room 214 for integration practice.',
        action_items: ['Bring integration by parts questions to Room 214'],
        quiz_alerts: ['Unit 6 In-Class Test tomorrow']
      }
    },
    {
      id: 'ann_demo_3',
      title: 'Water Quality Field Titration Lab Safety Reminder',
      context_code: 'course_103',
      posted_at: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
      user_name: 'Dr. Sarah Henderson',
      message: '<p>Don\'t forget closed-toe shoes and safety goggles for tomorrow\'s pond water dissolved oxygen titration lab.</p>',
      clean_text: 'Don\'t forget closed-toe shoes and safety goggles for tomorrow\'s pond water dissolved oxygen titration lab.',
      executive_summary: {
        bottom_line: 'Bring closed-toe shoes and safety goggles for water quality field lab.',
        action_items: ['Pack safety goggles and wear closed-toe shoes'],
        quiz_alerts: ['Lab report due tomorrow 11:59 PM']
      }
    }
  ],
  resources: [
    {
      id: 'res_demo_1',
      course_id: '101',
      course_name: 'P1 - AP Calculus BC - Martinez',
      category: 'reference',
      title: 'AP Calculus BC — Integration Techniques & Series Convergence Reference',
      format: 'pdf',
      size_label: '2.4 MB',
      description: 'Comprehensive formula sheet for integration by parts, partial fractions, and Taylor series tests.',
      download_url: '#',
      preview_url: '#',
      instructor: 'Maria Martinez',
      unit: 'Unit 6'
    },
    {
      id: 'res_demo_2',
      course_id: '102',
      course_name: 'P2 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Traditions & Encounters: Chapter 24 — New Worlds in the Americas',
      format: 'pdf',
      size_label: '19.1 MB',
      description: 'Full textbook chapter covering Iberian colonization, North American settler societies, and labor systems.',
      download_url: '#',
      preview_url: '#',
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_demo_3',
      course_id: '103',
      course_name: 'P3 - AP Environmental Science - Henderson',
      category: 'reference',
      title: 'Water Quality Standards & Titration Protocols Handbook',
      format: 'pdf',
      size_label: '4.2 MB',
      description: 'Official EPA dissolved oxygen, fecal coliform, and nutrient load titration formulas.',
      download_url: '#',
      preview_url: '#',
      instructor: 'Dr. Sarah Henderson',
      unit: 'Unit 4'
    },
    {
      id: 'res_demo_4',
      course_id: '104',
      course_name: 'P4 - Honors English Literature - Thornton',
      category: 'textbooks',
      title: 'Shakespeare: Hamlet Annotated Text & Critical Soliloquy Guide',
      format: 'pdf',
      size_label: '1.8 MB',
      description: 'Line-by-line critical annotations, existential philosophical notes, and rubric standards.',
      download_url: '#',
      preview_url: '#',
      instructor: 'Rachel Thornton',
      unit: 'Unit 3'
    }
  ],
  pacingCalendar: CONDER_PACING_CALENDAR
};

function getCuratedCourseResources(canvasBaseUrl = 'https://wcpss.instructure.com') {
  const base = String(canvasBaseUrl || 'https://wcpss.instructure.com').replace(/\/+$/, '');
  return [
    {
      id: 'res_world_ch22',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 22 — Transoceanic Encounters & Global Connections',
      format: 'pdf',
      size_label: '18.4 MB',
      description: 'Bentley & Ziegler Traditions & Encounters. European exploration, navigational tech, Indian Ocean trade networks, and early colonial outposts.',
      download_url: `${base}/courses/1414245/files/120579661/download?verifier=fa94ae2d-09a9-4fc2-a5d6-7cc34b3e4573`,
      preview_url: `${base}/courses/1414245/files/120579661?verifier=fa94ae2d-09a9-4fc2-a5d6-7cc34b3e4573&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch23',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 23 — The Transformation of Europe',
      format: 'pdf',
      size_label: '16.8 MB',
      description: 'The Protestant Reformation, Catholic Counter-Reformation, consolidation of sovereign states, and early capitalism.',
      download_url: `${base}/courses/1414245/files/120579738/download?verifier=5d31f8de-df04-4948-9bf1-d72a85160f85`,
      preview_url: `${base}/courses/1414245/files/120579738?verifier=5d31f8de-df04-4948-9bf1-d72a85160f85&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch24',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 24 — New Worlds: The Americas and Oceania',
      format: 'pdf',
      size_label: '19.1 MB',
      description: 'The Spanish Caribbean conquest, conquest of Mexico & Peru, Iberian colonial societies, North American settler colonies, and encomienda labor.',
      download_url: `${base}/courses/1414245/files/120579765/download?verifier=63a9142a-e704-43bc-ba29-8d0c44fc0d00`,
      preview_url: `${base}/courses/1414245/files/120579765?verifier=63a9142a-e704-43bc-ba29-8d0c44fc0d00&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch25',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 25 — Africa and the Atlantic World',
      format: 'pdf',
      size_label: '17.5 MB',
      description: 'Songhai Empire, Kingdom of Kongo, the transatlantic slave trade, Middle Passage, plantation societies, and African diaspora cultures.',
      download_url: `${base}/courses/1414245/files/120579798/download?verifier=73416055-b327-444c-9065-10a31d8b7a63`,
      preview_url: `${base}/courses/1414245/files/120579798?verifier=73416055-b327-444c-9065-10a31d8b7a63&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch26',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 26 — Tradition and Change in East Asia',
      format: 'pdf',
      size_label: '15.9 MB',
      description: 'Ming and Qing dynasties, the civil service examination system, neo-Confucianism, Tokugawa Shogunate, and Japanese isolationism (sakoku).',
      download_url: `${base}/courses/1414245/files/120579854/download?verifier=fffa531d-e61f-498c-a517-bd5604ce81fb`,
      preview_url: `${base}/courses/1414245/files/120579854?verifier=fffa531d-e61f-498c-a517-bd5604ce81fb&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch27',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 27 — The Islamic Empires',
      format: 'pdf',
      size_label: '16.3 MB',
      description: 'Formation of the Ottoman, Safavid, and Mughal Gunpowder Empires, religious policies, devshirme, and cultural synthesis.',
      download_url: `${base}/courses/1414245/files/120579898/download?verifier=701d21a6-927e-4fe2-8a3c-b6ddb97121d2`,
      preview_url: `${base}/courses/1414245/files/120579898?verifier=701d21a6-927e-4fe2-8a3c-b6ddb97121d2&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 3/4 (1450–1750)'
    },
    {
      id: 'res_world_ch13',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 13 — The Resurgence of Empire in East Asia',
      format: 'pdf',
      size_label: '14.7 MB',
      description: 'Restoration of centralized imperial rule in China under the Sui, Tang, and Song dynasties. Agricultural development, tech innovations, and East Asian influence.',
      download_url: `${base}/courses/1414245/files/118257198/download?verifier=ad6e5e07-27cd-47e7-aeef-87724765ad7a`,
      preview_url: `${base}/courses/1414245/files/118257198?verifier=ad6e5e07-27cd-47e7-aeef-87724765ad7a&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 1 (1200–1450)'
    },
    {
      id: 'res_world_cal_nov',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'calendars',
      title: 'Official November Reading & Pacing Calendar (Unit 4)',
      format: 'pdf',
      size_label: '19.7 KB',
      description: 'Official day-by-day A/B calendar detailing daily reading page targets (Ch. 24, 25, 23, 26, 27), Chapter 22/24/25 quizzes, and the Unit 4 Test on Nov 30.',
      download_url: `${base}/courses/1414245/files/120626470/download?verifier=e0b3aeb3-0bd3-4db2-8126-909d5758396c`,
      preview_url: `${base}/courses/1414245/files/120626470?verifier=e0b3aeb3-0bd3-4db2-8126-909d5758396c&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 Pacing'
    },
    {
      id: 'res_world_cal_oct',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'calendars',
      title: 'Official October Reading Calendar (Units 2 & 3)',
      format: 'pdf',
      size_label: '21.4 KB',
      description: 'October reading pacing calendar covering Mongol integration, Islamic realm expansion, and maritime trade milestones.',
      download_url: `${base}/courses/1414245/files/120597493/download?verifier=5c9b3fb7-91e6-4e40-bea6-2b871e95894c`,
      preview_url: `${base}/courses/1414245/files/120597493?verifier=5c9b3fb7-91e6-4e40-bea6-2b871e95894c&wrap=1`,
      instructor: 'David Conder',
      unit: 'Units 2–3 Pacing'
    },
    {
      id: 'res_world_cal_dec',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'calendars',
      title: 'Official December Reading & Semester Final Calendar',
      format: 'pdf',
      size_label: '18.9 KB',
      description: 'December reading pacing calendar detailing semester wrap-up, Gunpowder Empires review, and fall final exam preparation.',
      download_url: `${base}/courses/1414245/files/120626491/download?verifier=e0472fa3-0844-4321-9c27-1d23fdfede34`,
      preview_url: `${base}/courses/1414245/files/120626491?verifier=e0472fa3-0844-4321-9c27-1d23fdfede34&wrap=1`,
      instructor: 'David Conder',
      unit: 'Semester 1 Wrap-up'
    },
    {
      id: 'res_world_syllabus',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'syllabus',
      title: 'AP World History: Modern — Official Course Syllabus',
      format: 'pdf',
      size_label: '245 KB',
      description: 'Official syllabus: contact info (dconder@wcpss.net, 919-856-7918), grading weighting, minor assessment retest policies, and AP exam expectations.',
      download_url: `${base}/courses/1414245/files/119787734/download?verifier=bab3e9b9-1f6d-40b2-a996-1fa49087eb77`,
      preview_url: `${base}/courses/1414245/files/119787734?verifier=bab3e9b9-1f6d-40b2-a996-1fa49087eb77&wrap=1`,
      instructor: 'David Conder',
      unit: 'Course Policy'
    },
    {
      id: 'res_calc_log_key',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'Logarithmic Differentiation — 5 Practice Problems & Solutions Key',
      format: 'docx',
      size_label: '48.2 KB',
      description: 'Official solution key for logarithmic differentiation problems with corrected superscripts, step-by-step natural log applications, and product rule expansions.',
      download_url: `${base}/courses/1414714/files/122488345/download?verifier=eb98b628-f699-4106-a3d9-749ad19bd1d3`,
      preview_url: `${base}/courses/1414714/files/122488345?verifier=eb98b628-f699-4106-a3d9-749ad19bd1d3&wrap=1`,
      instructor: 'William Potter',
      unit: 'Unit 3 Differentiation'
    },
    {
      id: 'res_calc_implicit_key',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'Implicit Differentiation — Solution Key & Student Workspace',
      format: 'docx',
      size_label: '42.6 KB',
      description: 'Official solution key and printable workspace for implicit differentiation problems, tangent lines, and higher-order implicit derivatives.',
      download_url: `${base}/courses/1414714/files/122453485/download?verifier=74547806-3033-48ff-81c1-25c55c6dc6a4`,
      preview_url: `${base}/courses/1414714/files/122453485?verifier=74547806-3033-48ff-81c1-25c55c6dc6a4&wrap=1`,
      instructor: 'William Potter',
      unit: 'Unit 3 Differentiation'
    },
    {
      id: 'res_calc_packet_key',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'Derivative Rules Master Solution Key & Practice Packet',
      format: 'docx',
      size_label: '56.1 KB',
      description: 'Comprehensive solutions packet covering Power Rule, Product Rule, Quotient Rule, Chain Rule, Exponential, and 6 Trigonometric functions.',
      download_url: `${base}/courses/1414714/files/120774035/download?verifier=12bbb7d3-b274-4b40-b0a2-043aa55b5a8e`,
      preview_url: `${base}/courses/1414714/files/120774035?verifier=12bbb7d3-b274-4b40-b0a2-043aa55b5a8e&wrap=1`,
      instructor: 'William Potter',
      unit: 'Unit 2/3 Rules'
    },
    {
      id: 'res_calc_mock_final',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'AP Calculus AB Derivative Practice & Curve Sketching Mock Test',
      format: 'docx',
      size_label: '64.8 KB',
      description: '10 comprehensive test-prep problems: 5 curve sketching, 3 limit definition of derivative (f(x+h) - f(x))/h, and tangent line equations.',
      download_url: `${base}/courses/1414714/files/120071840/download?verifier=2d09db0c-6fe3-44fd-847b-02b464049df8`,
      preview_url: `${base}/courses/1414714/files/120071840?verifier=2d09db0c-6fe3-44fd-847b-02b464049df8&wrap=1`,
      instructor: 'William Potter',
      unit: 'Exam Prep'
    },
    {
      id: 'res_macro_unit1_guide',
      course_id: '1414258',
      course_name: 'P4 - AP Macroeconomics - Conder',
      category: 'keys',
      title: 'AP Macroeconomics Unit 1 Study Guide & Formula Summary',
      format: 'docx',
      size_label: '38.4 KB',
      description: 'Study guide covering scarcity, opportunity cost, Production Possibilities Curve (PPC), comparative vs. absolute advantage, and supply/demand equilibrium.',
      download_url: `${base}/courses/1414258/files/119338808/download?verifier=8f065c0c-86c2-4c70-8671-dc2e9a27db78`,
      preview_url: `${base}/courses/1414258/files/119338808?verifier=8f065c0c-86c2-4c70-8671-dc2e9a27db78&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 1 Basic Economic Concepts'
    },
    {
      id: 'res_macro_multipliers_sheet',
      course_id: '1414258',
      course_name: 'P4 - AP Macroeconomics - Conder',
      category: 'reference',
      title: 'Propensities, Multipliers & AD/AS Formula Sheet',
      format: 'link',
      size_label: 'Web Tool',
      description: 'ReviewEcon interactive multipliers guide: Marginal Propensity to Consume (MPC), MPS, Spending Multiplier (1/MPS), Tax Multiplier (-MPC/MPS), and Aggregate Demand.',
      download_url: `https://www.reviewecon.com/propensities-and-multipliers`,
      preview_url: `https://www.reviewecon.com/propensities-and-multipliers`,
      instructor: 'David Conder',
      unit: 'Unit 3 National Income & Price Determination'
    },
    {
      id: 'res_chem_ref_tables',
      course_id: '1414296',
      course_name: 'P1 - Chemistry Honors - Gollihue',
      category: 'reference',
      title: 'North Carolina Chemistry Reference Tables & Formulas',
      format: 'pdf',
      size_label: '840 KB',
      description: 'Periodic Table of the Elements, Polyatomic Ions, Solubility Rules, Specific Heat Values, Vapor Pressure of Water, and Gas Law Formulas.',
      download_url: `https://www.dpi.nc.gov/chemistry-reference-tables/download`,
      preview_url: `https://www.dpi.nc.gov/chemistry-reference-tables/download`,
      instructor: 'Jessica Gollihue',
      unit: 'Reference'
    },
    {
      id: 'res_math_desmos',
      course_id: '1414714',
      course_name: 'General Academic Tools',
      category: 'reference',
      title: 'Desmos Graphing Calculator & Curve Analysis',
      format: 'link',
      size_label: 'Web App',
      description: 'Official Desmos graphing calculator for visualizing derivatives, tangents, curve intersections, and polar/parametric equations.',
      download_url: `https://student.desmos.com/`,
      preview_url: `https://student.desmos.com/`,
      instructor: 'All Teachers',
      unit: 'Interactive Math'
    }
  ];
}

  // -------------------------------------------------------------------------
  // 1. WebCrypto AES-256-GCM Token-Keyed Decryption & Google Device Vault
  // -------------------------------------------------------------------------
  function logSecurityEvent(method, endpoint, note = 'Read-Only Verified') {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    state.securityAuditLog.unshift(`[${ts}] ${method} ${endpoint} — ${note}`);
    if (state.securityAuditLog.length > 50) state.securityAuditLog.pop();
    renderSecurityAuditModal();
  }

  function renderSecurityAuditModal() {
    if (!els.securityAuditLogBox) return;
    if (els.auditLogCountBadge) {
      els.auditLogCountBadge.textContent = `${state.securityAuditLog.length} read-only calls`;
    }
    if (state.securityAuditLog.length === 0) {
      els.securityAuditLogBox.innerHTML =
        '<p class="secondary-copy">Session initialized. Zero write/mutation calls permitted.</p>';
      return;
    }
    els.securityAuditLogBox.innerHTML = state.securityAuditLog
      .map((line) => `<div class="truncate">${escapeHtml(line)}</div>`)
      .join('');
  }

  async function deriveWebCryptoKey(secretStr, saltBytes) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(secretStr),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function decryptTokenKeyedSnapshot(rawToken, bundleStr) {
    if (!bundleStr || !rawToken) return null;
    const parts = String(bundleStr).split('.');
    if (parts.length !== 3) return null;
    if (!window.crypto?.subtle) {
      throw new Error('This browser does not support secure snapshot decryption.');
    }
    const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const salt = fromB64(parts[0]);
    const iv = fromB64(parts[1]);
    const ciphertextWithTag = fromB64(parts[2]);
    const key = await deriveWebCryptoKey(rawToken.trim(), salt);
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertextWithTag
    );
    logSecurityEvent('AES-256-GCM', 'PBKDF2-SHA256 (100k)', 'Snapshot Decrypted Locally');
    return JSON.parse(new TextDecoder().decode(plainBuf));
  }

  // Zero-Config Google Account Device Vault (AES-256-GCM encrypted in localStorage)
  function getOrCreateDeviceSecret() {
    if (!window.crypto?.getRandomValues) {
      throw new Error('This browser cannot create a secure device key.');
    }
    let secret = getStoredItem('localStorage', 'slated_device_key_v1');
    if (!secret) {
      const bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      setStoredItem('localStorage', 'slated_device_key_v1', secret);
    }
    return secret;
  }

  async function saveEncryptedGoogleVault({ canvasBaseUrl, canvasApiToken, googleEmail, displayName }) {
    try {
      if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
        throw new Error('This browser does not support secure account storage.');
      }
      const secret = getOrCreateDeviceSecret();
      const salt = new Uint8Array(16);
      const iv = new Uint8Array(12);
      window.crypto.getRandomValues(salt);
      window.crypto.getRandomValues(iv);
      const key = await deriveWebCryptoKey(secret, salt);
      const payload = JSON.stringify({
        canvasBaseUrl,
        canvasApiToken,
        googleEmail: googleEmail || '',
        displayName: displayName || 'Student',
        savedAt: new Date().toISOString(),
      });
      const cipherBuf = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(payload)
      );
      const toB64 = (u8) => btoa(String.fromCharCode(...u8));
      const bundle = `${toB64(salt)}.${toB64(iv)}.${toB64(new Uint8Array(cipherBuf))}`;
      setStoredItem('localStorage', 'slated_google_vault_enc', bundle);
      setStoredItem(
        'localStorage',
        'slated_google_profile_meta',
        JSON.stringify({
          googleEmail: googleEmail || 'Connected Account',
          displayName: displayName || 'Student',
        })
      );
    } catch (error) {
      console.warn('Could not save the encrypted account on this device:', error);
      showToast('This browser could not save the encrypted account. You may need to reconnect next time.', 5000);
    }
  }

  async function loadEncryptedGoogleVault() {
    try {
      const bundle = getStoredItem('localStorage', 'slated_google_vault_enc');
      const secret = getStoredItem('localStorage', 'slated_device_key_v1');
      if (!bundle || !secret) return null;
      const parts = bundle.split('.');
      if (parts.length !== 3) return null;
      const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const key = await deriveWebCryptoKey(secret, fromB64(parts[0]));
      const plainBuf = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(parts[1]) },
        key,
        fromB64(parts[2])
      );
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch (error) {
      console.warn('Could not load the saved encrypted account:', error);
      return null;
    }
  }

  function renderSavedGoogleBox() {
    if (!els.savedGoogleAccountBox) return;
    try {
      const metaRaw = getStoredItem('localStorage', 'slated_google_profile_meta');
      const hasVault = Boolean(getStoredItem('localStorage', 'slated_google_vault_enc'));
      if (!metaRaw || !hasVault) {
        els.savedGoogleAccountBox.classList.add('hidden');
        return;
      }
      const meta = JSON.parse(metaRaw);
      const name = meta.displayName || 'Student';
      const email = meta.googleEmail || 'Google Account Linked';
      els.savedGoogleName.textContent = name;
      els.savedGoogleEmail.textContent = email;
      els.savedGoogleAvatar.textContent = name.charAt(0).toUpperCase();
      els.continueGoogleFirstName.textContent = name.split(' ')[0];
      els.savedGoogleAccountBox.classList.remove('hidden');
    } catch (error) {
      console.warn('Saved account metadata is invalid:', error);
      els.savedGoogleAccountBox.classList.add('hidden');
    }
  }

  function parseEnvTextClient(text) {
    const out = {};
    for (const rawLine of String(text || '').split(/\r?\n/)) {
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

  function extractTokenAndUrl(rawTokenInput, rawUrlInput) {
    let token = String(rawTokenInput || '').trim();
    let url = String(rawUrlInput || 'https://wcpss.instructure.com').trim();
    if (token.includes('CANVAS_API_TOKEN=')) {
      const parsed = parseEnvTextClient(token);
      if (parsed.CANVAS_API_TOKEN) token = parsed.CANVAS_API_TOKEN;
      if (parsed.CANVAS_BASE_URL) url = parsed.CANVAS_BASE_URL;
    }
    token = token.replace(/^["']|["']$/g, '').trim();
    url = url.replace(/^(https?):\/([^/])/i, '$1://$2').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Please enter a valid Canvas school URL.');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Canvas school URLs must use HTTPS.');
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('Canvas URLs must not contain embedded credentials.');
    }
    if (parsedUrl.port && parsedUrl.port !== '443') {
      throw new Error('Canvas URLs must use the standard HTTPS port.');
    }
    return { token, url: `${parsedUrl.protocol}//${parsedUrl.hostname}` };
  }

  function maskTokenClient(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    if (t.length <= 10) return '••••••••';
    return `${t.slice(0, 5)}••••••••${t.slice(-4)}`;
  }

  // -------------------------------------------------------------------------
  // 1.5 Token Lifecycle: 30-day expiry tracking, renewal reminders, auto-erase
  // -------------------------------------------------------------------------
  // Only a one-way SHA-256 fingerprint + timestamps are stored — never the token itself.
  const TOKEN_LIFECYCLE_KEY = 'slated_token_lifecycle';
  const TOKEN_LIFETIME_DAYS = 30;
  const TOKEN_WARN_DAYS = 5;
  const DAY_MS = 86400 * 1000;

  async function tokenFingerprint(token) {
    if (!window.crypto?.subtle) return null;
    try {
      const buf = await window.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(String(token || '').trim())
      );
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
    } catch (error) {
      console.warn('Token expiry tracking is unavailable in this browser:', error);
      return null;
    }
  }

  function getTokenLifecycle() {
    try {
      const lc = readStoredJson(TOKEN_LIFECYCLE_KEY, null, (value) => value === null || typeof value === 'object');
      return lc && lc.expiresAt ? lc : null;
    } catch (error) {
      console.warn('Could not read token expiry information:', error);
      return null;
    }
  }

  function saveTokenLifecycle(lc) {
    try {
      setStoredItem('localStorage', TOKEN_LIFECYCLE_KEY, JSON.stringify(lc));
    } catch (error) {
      console.warn('Could not save token expiry information:', error);
    }
  }

  async function registerTokenLifecycle(token, baseUrl) {
    if (!token) return;
    const fp = await tokenFingerprint(token);
    if (!fp) return;
    const existing = getTokenLifecycle();
    if (existing && existing.fingerprint === fp) {
      existing.baseUrl = baseUrl || existing.baseUrl;
      saveTokenLifecycle(existing);
      return;
    }
    const now = Date.now();
    saveTokenLifecycle({
      fingerprint: fp,
      baseUrl: baseUrl || state.canvasBaseUrl,
      connectedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TOKEN_LIFETIME_DAYS * DAY_MS).toISOString(),
      expirySource: 'estimated',
      autoWipe: true,
    });
  }

  function getTokenDaysLeft() {
    const lc = getTokenLifecycle();
    if (!lc) return null;
    return Math.ceil((new Date(lc.expiresAt).getTime() - Date.now()) / DAY_MS);
  }

  function wipeLocalTokenVault() {
    removeStoredItem('sessionStorage', 'atelier_active_token_session');
    removeStoredItem('localStorage', 'slated_google_vault_enc');
    browserRamCreds = null;
    unlockedSnapshotData = null;
  }

  function showExpiredTokenNotice(message) {
    if (els.quickConnectError) {
      els.quickConnectError.textContent = message;
      els.quickConnectError.classList.remove('hidden');
    }
  }

  // Returns true if the token was expired and erased.
  function enforceTokenExpiry() {
    const lc = getTokenLifecycle();
    if (!lc) return false;
    const daysLeft = getTokenDaysLeft();
    if (daysLeft > 0) return false;
    if (lc.autoWipe !== false) {
      wipeLocalTokenVault();
      removeStoredItem('localStorage', TOKEN_LIFECYCLE_KEY);
      showExpiredTokenNotice(
        'Your Canvas token reached its 30-day limit and was erased from this device. Generate a fresh token in Canvas and paste it below.'
      );
      return true;
    }
    return false;
  }

  function handleTokenRejected() {
    wipeLocalTokenVault();
    removeStoredItem('localStorage', TOKEN_LIFECYCLE_KEY);
    showExpiredTokenNotice(
      'Canvas rejected this token — it expired or was revoked. It has been erased from this device. Paste a fresh token to continue.'
    );
  }

  function renderTokenLifecycleUI() {
    const lc = getTokenLifecycle();
    const daysLeft = getTokenDaysLeft();
    const chip = document.getElementById('tokenExpiryChip');
    const banner = document.getElementById('tokenRenewBanner');
    const label = document.getElementById('tokenExpiryLabel');
    const dateInput = document.getElementById('tokenExpiryDateInput');
    const autoWipe = document.getElementById('tokenAutoWipeToggle');
    const renewLink = document.getElementById('renewTokenLink');
    const base = (lc && lc.baseUrl) || state.canvasBaseUrl || 'https://wcpss.instructure.com';
    const renewUrl = `${base.replace(/\/+$/, '')}/profile/settings`;

    if (renewLink) renewLink.href = safeHttpUrl(renewUrl) || '#';

    if (!lc || daysLeft == null) {
      if (chip) chip.classList.add('hidden');
      if (banner) banner.classList.add('hidden');
      if (label) label.textContent = 'Not tracked (server-managed token)';
      return;
    }

    const expDate = new Date(lc.expiresAt);
    const expText = expDate.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const tone = daysLeft <= 2 ? 'var(--urgent)' : daysLeft <= TOKEN_WARN_DAYS ? 'var(--soon)' : 'var(--calm)';

    if (chip) {
      chip.classList.remove('hidden');
      chip.innerHTML = `<span class="status-dot" style="background:${tone};"></span><span>${
        daysLeft <= 0 ? 'Token expired' : `Token ${daysLeft}d`
      }</span>`;
      chip.title = `Canvas token expires ${expText}${lc.expirySource === 'estimated' ? ' (estimated)' : ''}`;
    }

    if (label) {
      label.textContent = `${expText} • ${Math.max(0, daysLeft)} day${daysLeft === 1 ? '' : 's'} left${
        lc.expirySource === 'estimated' ? ' (est.)' : ''
      }`;
    }
    if (dateInput) {
      const y = expDate.getFullYear();
      const m = String(expDate.getMonth() + 1).padStart(2, '0');
      const d = String(expDate.getDate()).padStart(2, '0');
      dateInput.value = `${y}-${m}-${d}`;
    }
    if (autoWipe) autoWipe.checked = lc.autoWipe !== false;

    if (banner) {
      if (daysLeft <= TOKEN_WARN_DAYS) {
        banner.style.borderLeftColor = tone;
        banner.innerHTML = `
          <div class="space-y-0.5">
            <p class="text-sm font-bold">${
              daysLeft <= 0
                ? 'Your Canvas token has expired'
                : `Your Canvas token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${escapeHtml(expText)})`
            }</p>
            <p class="text-xs secondary-copy">Generate a new one in Canvas, then paste it under your account. Your tasks, briefings, and settings stay put.</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <a href="${escapeHtml(safeHttpUrl(renewUrl) || '#')}" target="_blank" rel="noopener noreferrer" class="studio-btn studio-btn-primary text-xs py-2 px-3">Open Canvas Settings</a>
            <button type="button" data-open-token-modal class="studio-btn tone-surface-2 text-xs py-2 px-3">Paste New Token</button>
          </div>`;
        banner.classList.remove('hidden');
        const btn = banner.querySelector('[data-open-token-modal]');
        if (btn) btn.addEventListener('click', openTokenModal);
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (url.startsWith('/api/v1/')) {
      logSecurityEvent('GET', url.split('?')[0], 'Read-Only Canvas Proxy');
    }
    const headers = {
      'X-Requested-With': 'CanvasHub',
      ...(options.headers || {}),
    };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const target = url.startsWith('http') ? url : `${state.apiOrigin}${url}`;
    return fetch(target, {
      credentials: 'include',
      ...options,
      method,
      headers,
    });
  }

  // -------------------------------------------------------------------------
  // 2. Curated Studio Color Palettes ("obsidian", "paper", "midnight", "forest")
  // -------------------------------------------------------------------------
  function applyPalette(paletteName) {
    const valid = ['obsidian', 'paper', 'midnight', 'forest'];
    const chosen = valid.includes(paletteName) ? paletteName : 'obsidian';
    state.palette = chosen;
    setStoredItem('localStorage', 'slated_palette', chosen);
    els.html.setAttribute('data-palette', chosen);
    if (chosen === 'paper') {
      els.html.classList.remove('dark');
    } else {
      els.html.classList.add('dark');
    }

    document.querySelectorAll('.palette-btn').forEach((btn) => {
      const isMatch = btn.getAttribute('data-set-palette') === chosen;
      btn.style.backgroundColor = isMatch ? 'var(--accent)' : 'transparent';
      btn.style.color = isMatch ? 'var(--accent-ink)' : 'var(--ink-secondary)';
    });
  }

  function showToast(message, actionText = null, actionFn = null) {
    if (!els.toastBanner || !els.toastMessage) return;
    clearTimeout(showToast._timer);
    const durationMs =
      typeof actionText === 'number' && Number.isFinite(actionText) && actionText > 0
        ? actionText
        : 4500;
    if (typeof actionText === 'number') actionText = null;

    if (actionText && typeof actionFn === 'function') {
      els.toastMessage.innerHTML = `${escapeHtml(message)} <button type="button" id="toastActionBtn" class="ml-3 underline font-bold" style="color: var(--accent); cursor: pointer;">${escapeHtml(actionText)}</button>`;
      const btn = els.toastMessage.querySelector('#toastActionBtn');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          els.toastBanner.classList.add('hidden');
          actionFn();
        });
      }
    } else {
      els.toastMessage.textContent = message;
    }

    els.toastBanner.classList.remove('hidden');
    showToast._timer = setTimeout(() => {
      els.toastBanner.classList.add('hidden');
    }, durationMs);
  }

  function launchConfetti(originX, originY) {
    try {
      let canvas = document.getElementById('celebrationCanvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'celebrationCanvas';
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '99999';
        document.body.appendChild(canvas);
      }
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const startX = originX != null ? originX : window.innerWidth / 2;
      const startY = originY != null ? originY : window.innerHeight * 0.45;

      const colors = ['#2563eb', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#e11d48'];
      const particleCount = 75;
      const particles = [];

      for (let i = 0; i < particleCount; i++) {
        const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.5;
        const speed = 4 + Math.random() * 8;
        particles.push({
          x: startX,
          y: startY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 2.5,
          size: 6 + Math.random() * 5,
          color: colors[Math.floor(Math.random() * colors.length)],
          rotation: Math.random() * 360,
          rotSpeed: (Math.random() - 0.5) * 14,
          opacity: 1,
          drag: 0.94 + Math.random() * 0.04,
          gravity: 0.32,
        });
      }

      let startTime = null;
      function step(timestamp) {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let activeCount = 0;
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.vy += p.gravity;
          p.vx *= p.drag;
          p.vy *= p.drag;
          p.rotation += p.rotSpeed;
          p.opacity = Math.max(0, 1 - elapsed / 1100);

          if (p.opacity > 0 && p.y < canvas.height + 50) {
            activeCount++;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.opacity;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
            ctx.restore();
          }
        }

        if (activeCount > 0 && elapsed < 1200) {
          requestAnimationFrame(step);
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
      requestAnimationFrame(step);
    } catch (error) {
      console.warn('Celebration animation is unavailable:', error);
    }
  }

  function playSuccessChime() {
    if (state.soundMuted) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();

      // Major chord triad: C5 (523.25 Hz), E5 (659.25 Hz), G5 (783.99 Hz)
      const freqs = [523.25, 659.25, 783.99];
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.065);

        gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.065);
        gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + idx * 0.065 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.065 + 0.45);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime + idx * 0.065);
        osc.stop(ctx.currentTime + idx * 0.065 + 0.5);
      });
    } catch (error) {
      console.warn('Success sound is unavailable:', error);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  
  // Clean readable math formatter (Cambria Math font, proper exponents, fractions & operators)
  function formatMathHtml(rawText) {
    if (!rawText) return '';
    let s = String(rawText);
    // Escape HTML first
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Convert common powers like x^2, (x+1)^3, y^3, (x^2+1)^sin(x), x^(sin(x)-1) into <sup> tags
    s = s.replace(/\^\(([^()]+)\)/g, '<sup class="math-sup font-math">$1</sup>');
    s = s.replace(/\^([a-zA-Z0-9]+)/g, '<sup class="math-sup font-math">$1</sup>');
    // Unicode exponents to sup
    s = s.replace(/([²³⁴⁵⁶⁷⁸⁹])/g, (m) => {
      const map = { '²':'2', '³':'3', '⁴':'4', '⁵':'5', '⁶':'6', '⁷':'7', '⁸':'8', '⁹':'9' };
      return '<sup class="math-sup font-math">' + (map[m] || m) + '</sup>';
    });
    // Replace * with clean math dot
    s = s.replace(/\s*\*\s*/g, ' · ');
    // Wrap whole expression in math-font span
    return '<span class="math-font font-math">' + s + '</span>';
  }

  function stripHtml(html) {

    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  }

  // -------------------------------------------------------------------------
  // 3. Universal School Bell Schedule, A/B Block & Room Resolver + Effort Engine
  // -------------------------------------------------------------------------
  const DEFAULT_SCHEDULE_CONFIG = {
    schoolName: 'School Workspace',
    p3LunchMode: '2nd', // '2nd' = East Bldg & Non-Towers West (10:35-12:08) | '1st' = Towers (11:20-12:47)
    periods: {
      P1: {
        period: 'P1',
        label: 'Period 1',
        startText: '7:25 AM',
        endText: '8:52 AM',
        rangeText: '7:25 – 8:52 AM',
        startHour: 7,
        startMin: 25,
        endHour: 8,
        endMin: 52,
      },
      P2: {
        period: 'P2',
        label: 'Period 2',
        startText: '8:58 AM',
        endText: '10:35 AM',
        rangeText: '8:58 – 10:35 AM',
        startHour: 8,
        startMin: 58,
        endHour: 10,
        endMin: 35,
      },
      P3_2ND: {
        period: 'P3',
        label: 'Period 3 (2nd Lunch • East & Non-Towers West)',
        shortLunchLabel: '2nd Lunch (East / West)',
        startText: '10:35 AM',
        endText: '12:08 PM',
        rangeText: '10:35 AM – 12:08 PM',
        lunchRangeText: '12:14 – 12:47 PM',
        startHour: 10,
        startMin: 35,
        endHour: 12,
        endMin: 8,
      },
      P3_1ST: {
        period: 'P3',
        label: 'Period 3 (1st Lunch • Towers)',
        shortLunchLabel: '1st Lunch (Towers)',
        startText: '11:20 AM',
        endText: '12:47 PM',
        rangeText: '11:20 AM – 12:47 PM',
        lunchRangeText: '10:41 – 11:14 AM',
        startHour: 11,
        startMin: 20,
        endHour: 12,
        endMin: 47,
      },
      P4: {
        period: 'P4',
        label: 'Period 4',
        startText: '12:53 PM',
        endText: '2:20 PM',
        rangeText: '12:53 – 2:20 PM',
        startHour: 12,
        startMin: 53,
        endHour: 14,
        endMin: 20,
      },
    },
    courseOverrides: {}, // courseId -> { block: '1A', room: '2605' }
  };

  
  function deriveSchoolNameFromUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const parts = host.split('.');
      if (parts.length >= 3 && parts[1] === 'instructure') {
        const district = parts[0].toUpperCase();
        return district + ' Canvas';
      }
      return host.replace(/^www\./, '') + ' Canvas';
    } catch (_) {
      return 'School Workspace';
    }
  }
  
  function loadScheduleConfig() {
    try {
      const raw = getStoredItem('localStorage', 'slated_schedule_config');
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_CONFIG));
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SCHEDULE_CONFIG,
        ...parsed,
        periods: { ...DEFAULT_SCHEDULE_CONFIG.periods, ...(parsed.periods || {}) },
        courseOverrides: { ...(parsed.courseOverrides || {}) },
      };
    } catch (error) {
      console.warn('Stored schedule settings are invalid; using defaults:', error);
      removeStoredItem('localStorage', 'slated_schedule_config');
      return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_CONFIG));
    }
  }

  let scheduleConfig = loadScheduleConfig();

  function saveScheduleConfig() {
    try {
      setStoredItem('localStorage', 'slated_schedule_config', JSON.stringify(scheduleConfig));
    } catch (error) {
      console.warn('Could not save schedule settings:', error);
    }
  }

  function classifySchoolRoom(roomStr) {
    const clean = String(roomStr || '').trim();
    const numMatch = clean.match(/\b(\d{3,4})\b/);
    if (!numMatch) {
      return { room: clean, building: '', lunchWave: null };
    }
    const n = Number(numMatch[1]);
    // Enloe Magnet HS campus architecture:
    // Towers: 1600-1799, 2000-2199, 2400-2799 -> 1st Lunch (Class 11:20-12:47)
    // East Building: 100-999, 1800-1999, 2800-2999 -> 2nd Lunch (Class 10:35-12:08)
    // Non-Towers West: 1000-1599, 2200-2399 (e.g. Rm 1202 Main Office lab, Rm 2215) -> 2nd Lunch (Class 10:35-12:08)
    if ((n >= 1600 && n <= 1799) || (n >= 2000 && n <= 2199) || (n >= 2400 && n <= 2799)) {
      return { room: String(n), building: 'Towers', lunchWave: '1st' };
    }
    if ((n >= 100 && n <= 999) || (n >= 1800 && n <= 1999) || (n >= 2800 && n <= 2999)) {
      return { room: String(n), building: 'East Bldg', lunchWave: '2nd' };
    }
    if ((n >= 1000 && n <= 1599) || (n >= 2200 && n <= 2399)) {
      return { room: String(n), building: 'West Bldg', lunchWave: '2nd' };
    }
    return { room: String(n), building: '', lunchWave: null };
  }

  // Verified WCPSS / Enloe A/B Day Calendar (extracted from course syllabi & unit calendars)
  const KNOWN_AB_DATES = {
    '2026-10-26': 'A',
    '2026-10-27': 'B',
    '2026-10-28': 'A',
    '2026-10-29': 'B',
    '2026-10-30': 'A',
    '2026-11-02': 'B',
    '2026-11-03': 'OFF', // Teacher Workday / Election Day
    '2026-11-04': 'A',
    '2026-11-05': 'B',
    '2026-11-06': 'A',
    '2026-11-09': 'B',
    '2026-11-10': 'A',
    '2026-11-11': 'OFF', // Veterans Day Holiday
    '2026-11-12': 'B',
    '2026-11-13': 'A',
    '2026-11-16': 'B',
    '2026-11-17': 'A',
    '2026-11-18': 'B',
    '2026-11-19': 'A',
    '2026-11-20': 'B',
    '2026-11-23': 'A',
    '2026-11-24': 'B',
  };

  function getSchoolDayType(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(d.getTime())) return null;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return null;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    if (KNOWN_AB_DATES[key]) {
      return KNOWN_AB_DATES[key] === 'OFF' ? null : KNOWN_AB_DATES[key];
    }
    // Fallback weekday alternation anchored to 2026-11-09 = B
    const anchor = new Date(2026, 10, 9);
    let weekdays = 0;
    const cur = new Date(anchor);
    const step = d >= anchor ? 1 : -1;
    while (cur.toDateString() !== d.toDateString() && Math.abs(weekdays) < 200) {
      cur.setDate(cur.getDate() + step);
      if (cur.getDay() !== 0 && cur.getDay() !== 6) weekdays += step;
    }
    return Math.abs(weekdays) % 2 === 0 ? 'B' : 'A';
  }

  function parseCourseMeta(course) {
    if (!course) {
      return {
        period: 'Class',
        basePeriod: 'P1',
        abDay: '',
        block: 'Class',
        title: 'Class',
        teacher: '',
        room: '',
        building: '',
        lunchWave: null,
      };
    }
    const cid = String(course.id);
    const raw = String(course.name || '').trim();
    const teacherFromApi =
      course.teachers && course.teachers[0] && course.teachers[0].display_name
        ? course.teachers[0].display_name
        : '';

    const parts = raw.split(/\s+-\s+/);
    let basePeriod = '';
    let abDay = '';
    let title = raw;
    let teacher = teacherFromApi;

    if (parts.length >= 3 && /^P?\d+[AB]?$/i.test(parts[0])) {
      const pMatch = parts[0].toUpperCase().match(/^P?(\d+)([AB])?$/);
      if (pMatch) {
        basePeriod = `P${pMatch[1]}`;
        if (pMatch[2]) abDay = pMatch[2];
      }
      title = parts[1];
      if (!teacher && parts[2] && !/^\d{4}$/.test(parts[2])) {
        teacher = parts[2];
      }
    } else {
      title = raw
        .replace(/^\d{4}[-/]\d{2,4}\s*[-–—]?\s*/i, '')
        .replace(/\s+-\s+\d{4}$/, '')
        .trim();
    }

    // 1. Inspect Canvas Enrolled Sections (`include[]=sections`) — resolves cross-listed shells!
    // e.g. English II Honors has course.name "P1 - English II Honors - Hagan" but sections[0].name = "4A"
    // e.g. Chemistry Honors has sections[0].name = "1A- Chemistry Honors - Gollihue - 2027"
    // e.g. AP World History has sections[0].name = "B Day"
    const sections = Array.isArray(course.sections) ? course.sections : [];
    for (const sec of sections) {
      const sName = String(sec.name || '').trim();
      const explicitBlockMatch = sName.match(/^(?:P)?([1-8])([AB])\b/i);
      if (explicitBlockMatch) {
        basePeriod = `P${explicitBlockMatch[1]}`;
        abDay = explicitBlockMatch[2].toUpperCase();
      } else {
        const dayOnlyMatch = sName.match(/\b([AB])\s*Day\b/i);
        if (dayOnlyMatch) {
          abDay = dayOnlyMatch[1].toUpperCase();
        }
      }
    }

    // 2. Inspect course assignments & announcements for explicit section tags or room numbers
    let detectedRoom = '';
    const courseAssigns = state.assignments.filter((a) => String(a.course_id) === cid);
    for (const a of courseAssigns) {
      const aName = String(a.name || '');
      const tagMatch = aName.match(/\((?:P)?([1-8])([AB])\)/i);
      if (tagMatch) {
        if (!basePeriod) basePeriod = `P${tagMatch[1]}`;
        if (!abDay) abDay = tagMatch[2].toUpperCase();
      }
    }

    const courseAnns = state.announcements.filter(
      (ann) => String(ann.context_code || '').replace(/^course_/, '') === cid
    );
    for (const ann of courseAnns) {
      const text = `${ann.title || ''} ${ann.clean_text || stripHtml(ann.message || '')}`;
      // Check for "across hall from 2B" or similar period reference
      if (!abDay && basePeriod === 'P2' && /\b2B\b/.test(text)) {
        abDay = 'B';
      }
      if (!detectedRoom) {
        const rmMatch =
          text.match(/\broom\s*(\d{3,4})\b/i) ||
          text.match(/\b(\d{4})\s+before\s+school\b/i);
        if (rmMatch) {
          detectedRoom = rmMatch[1];
        }
      }
    }

    // 3. Cross-course Period Pairing & Verified Syllabus Room Directory
    const titleLower = title.toLowerCase();
    const teacherLower = String(teacher || '').toLowerCase();

    // 3. Dynamic Universal Period, Block & Room Resolution (works for ANY district, school, or state):
    if (!basePeriod) {
      const pGenMatch = (raw + ' ' + (course.course_code || '')).match(/\b(?:Period|Per|Block|Prd|P)\s*([1-8])\b/i);
      if (pGenMatch) basePeriod = 'P' + pGenMatch[1];
    }
    if (!abDay) {
      const dayGenMatch = (raw + ' ' + (course.course_code || '')).match(/\b([AB])\s*(?:Day|Block)?\b/i);
      if (dayGenMatch && /^[AB]$/i.test(dayGenMatch[1])) abDay = dayGenMatch[1].toUpperCase();
    }
    if (!detectedRoom) {
      const roomGenMatch = (course.syllabus_body || raw).match(/\b(?:Room|Rm|R\.)\s*([A-Za-z0-9-]+)\b/i);
      if (roomGenMatch) detectedRoom = roomGenMatch[1];
    }

    // Apply user custom override if configured for any school
    const userOverride = scheduleConfig.courseOverrides && scheduleConfig.courseOverrides[cid];
    if (userOverride) {
      if (userOverride.block) {
        const m = String(userOverride.block).trim().toUpperCase().match(/^P?(\d+)([AB])?$/);
        if (m) {
          basePeriod = `P${m[1]}`;
          abDay = m[2] || '';
        }
      }
      if (userOverride.room != null) {
        detectedRoom = String(userOverride.room).trim();
      }
    }

    const pNum = basePeriod ? basePeriod.replace(/^P/i, '') : '';
    const block = pNum ? (abDay ? `${pNum}${abDay}` : `P${pNum}`) : 'Class';
    const roomInfo = classifySchoolRoom(detectedRoom);

    return {
      period: block,
      basePeriod: basePeriod || 'P1',
      abDay,
      block,
      title: title || raw,
      teacher: teacher || '',
      room: roomInfo.room,
      building: roomInfo.building,
      lunchWave: roomInfo.lunchWave,
    };
  }

  function triggerRevealAnimations() {
    const items = document.querySelectorAll('.reveal-item:not(.is-visible)');
    items.forEach((el, idx) => {
      setTimeout(() => {
        el.classList.add('is-visible');
      }, idx * 40);
    });
  }

  function getPeriodBellObject(basePeriod, lunchWaveOverride = null) {
    const pKey = String(basePeriod || 'P1').toUpperCase();
    if (pKey === 'P3') {
      const wave = lunchWaveOverride || scheduleConfig.p3LunchMode || '2nd';
      return wave === '1st' ? scheduleConfig.periods.P3_1ST : scheduleConfig.periods.P3_2ND;
    }
    return scheduleConfig.periods[pKey] || scheduleConfig.periods.P1;
  }

  function getCourseBellInfo(courseId) {
    const course = state.courses.find((c) => String(c.id) === String(courseId));
    if (!course) return getPeriodBellObject('P1');
    const meta = parseCourseMeta(course);
    const bell = getPeriodBellObject(meta.basePeriod, meta.lunchWave);
    return {
      ...bell,
      period: meta.block || bell.period,
      basePeriod: meta.basePeriod,
      abDay: meta.abDay,
      room: meta.room,
      building: meta.building,
      lunchWave: meta.lunchWave || (meta.basePeriod === 'P3' ? scheduleConfig.p3LunchMode : null),
    };
  }

  function makeBellAlignedIso(year, monthNum, dayNum, courseId, alignTo = 'start') {
    const bell = getCourseBellInfo(courseId);
    const hr = alignTo === 'end' ? bell.endHour : bell.startHour;
    const mn = alignTo === 'end' ? bell.endMin : bell.startMin;
    const d = new Date(year, monthNum - 1, dayNum, hr, mn, 0);
    return d.toISOString();
  }

  function extractUnitNumber(text) {
    const s = String(text || '');
    const mUnit = s.match(/\b(?:Unit|Module|Unidad|Ch(?:apter)?)\s*(\d+)\b/i);
    if (mUnit) return Number(mUnit[1]);
    const mTopic = s.match(/\bTopic\s*(\d+)\.\d+/i);
    if (mTopic) return Number(mTopic[1]);
    const mShort = s.match(/\bU(\d+)(?:A\d+|\b|\s)/i);
    if (mShort) return Number(mShort[1]);
    const mSec = s.match(/\bSec(?:tion)?\s*(\d+)\.\d+/i);
    if (mSec) return Number(mSec[1]);
    return null;
  }

  // Deep Content, PDF, Textbook & Google Form Effort Estimator
  function estimateAssignmentEffort(a) {
    const name = String(a.name || '');
    const nameLower = name.toLowerCase();
    const descPlain = stripHtml(a.description || '');
    const combined = `${name} ${descPlain}`.toLowerCase();
    const pts = Number(a.points_possible) || 0;

    // 1. Announced or explicit quizzes/tests
    if (a.is_announcement_event || /\b(quiz|test|exam|midterm|frq)\b/.test(nameLower)) {
      const bell = getCourseBellInfo(a.course_id);
      return `${bell.period} (${bell.startText})`;
    }

    // 2. Explicit minutes or session counts found in PDF handouts or descriptions
    if (/colonial recruitment brochure/i.test(nameLower)) {
      return '~120m • 6-Panel Trifold + 4 SAQs';
    }
    if (/columbian exchange pbl/i.test(nameLower)) {
      return '~75m • 4-Page Menu PBL';
    }
    if (/columbian exchange.*posterboard/i.test(nameLower) || /two class sessions,\s*30 minutes each/i.test(combined)) {
      return '~60m • 2 Class Sessions';
    }

    const explicitMinsMatch = descPlain.match(/approximately\s*(\d{2,3})\s*minutes/i);
    if (explicitMinsMatch) {
      return `~${explicitMinsMatch[1]}m`;
    }

    // 3. Krugman AP Macroeconomics Textbook Modules + Google Forms
    if (/krugman\s*modules?/i.test(combined)) {
      const rangeMatch = name.match(/modules?\s*(\d+)\s*(?:[-–—&]|to|and)\s*(\d+)/i);
      if (rangeMatch) {
        const startMod = Number(rangeMatch[1]);
        const endMod = Number(rangeMatch[2]);
        const modCount = Math.max(1, endMod - startMod + 1);
        const estMins = modCount * 22;
        return `~${estMins}m • ${modCount} Modules (~${modCount * 10}p) + Form`;
      }
      return '~30m • 1 Module (~10p) + Form';
    }

    // 4. Multipliers, AD & AS Worksheet PDF + ReviewEcon
    if (/multipliers.*ad\s*&\s*as/i.test(nameLower)) {
      return '~50m • 19 Probs + ReviewEcon';
    }

    // 5. Gizmos Virtual Chemistry Labs
    if (/\bgizmos?\b/i.test(combined)) {
      return '~45m • Gizmos Lab + 5Q Check';
    }

    // 6. AP CSA CodeHS Java Programming Labs
    if (/\b(program\s*-|complex numbers|average 4 ways|codehs)\b/i.test(combined)) {
      return '~50m • Java Lab';
    }

    // 7. English II Speech / Rhetorical Annotations
    if (/prepared to die speech/i.test(nameLower)) {
      return '~40m • Speech Annotation + 6Qs';
    }

    // 8. Spanish Verb Drills & Screenshots
    if (/studyspanish|conjuguemos/i.test(combined)) {
      return '~25m • Verb Drills + PNG';
    }

    // 9. General project / practice fallbacks
    if (/\b(poster|project|essay|brochure|timeline|report|lab|seminar|portfolio)\b/.test(nameLower) || pts >= 50) {
      return '~50m • Project';
    }
    if (/\b(reading log|study guide|practice|packet|homework|hw|worksheet)\b/.test(nameLower) || pts >= 20) {
      return '~30m • Practice';
    }
    return '~20m';
  }

  function ensureAnnouncementSummarized(ann) {
    if (!ann) return null;
    if (ann.tldr && Array.isArray(ann.bullets)) return ann;

    const rawHtml = String(ann.message || '');
    const cleanText = stripHtml(rawHtml);
    const title = String(ann.title || 'Class Update').trim();
    const combinedLower = `${title} ${cleanText}`.toLowerCase();

    let category = 'Class Update';
    if (/\b(quiz|test|exam|assessment|midterm|frq)\b/i.test(combinedLower)) {
      category = 'Quiz / Test';
    } else if (/\b(due date|deadline|naa|submit|extended|extension)\b/i.test(combinedLower)) {
      category = 'Deadline Update';
    } else if (/\b(grade|infinite campus|retest|exempt|missing assignment|q1|quarter)\b/i.test(combinedLower)) {
      category = 'Grade Policy';
    } else if (
      (Array.isArray(ann.attachments) && ann.attachments.length > 0) ||
      /\b(solution|key|practice problems|worksheet|notes)\b/i.test(combinedLower)
    ) {
      category = 'Study Key';
    }

    const sentences = cleanText
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12 && !/^(hi|hello|dear|good morning|hey|students)\b/i.test(s));

    const prioritySentences = sentences.filter((s) =>
      /\b(quiz|test|due|monday|tuesday|wednesday|thursday|friday|11\/\d+|nov|rule|multiplier|aggregate|retest|exempt|submit|screenshot|homework|hw|sec\s*\d)/i.test(
        s
      )
    );

    const bullets = [];
    const seen = new Set();
    for (const cand of [...prioritySentences, ...sentences]) {
      const trimmed = cand.slice(0, 200);
      const key = trimmed.slice(0, 40).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.push(trimmed);
      if (bullets.length >= 4) break;
    }

    return {
      ...ann,
      clean_text: cleanText,
      author_name: ann.author_name || (ann.author && ann.author.display_name) || 'Teacher',
      is_long: cleanText.length > 260,
      char_count: cleanText.length,
      category,
      tldr: (bullets.slice(0, 2).join(' • ') || cleanText.slice(0, 220)).slice(0, 260),
      bullets,
      attachments: Array.isArray(ann.attachments) ? ann.attachments : [],
    };
  }


  // -------------------------------------------------------------------------
  // In-Class Assessments, Paperwork, Supplies Extraction, Topic Accelerators & Rubrics
  // -------------------------------------------------------------------------
  function isInClassOrPaperWork(a) {
    if (!a) return false;
    if (a.is_announcement_event) return true;
    if (a.no_online_submission === true) return true;

    // Check Canvas submission_types (e.g. ['on_paper'], ['none'], ['not_graded'])
    if (Array.isArray(a.submission_types)) {
      const types = a.submission_types;
      const hasOnline = types.some((t) =>
        ['online_upload', 'online_text_entry', 'online_url', 'media_recording', 'online_quiz'].includes(t)
      );
      if (!hasOnline && (types.includes('on_paper') || types.includes('none') || types.includes('not_graded') || types.includes('external_tool'))) {
        return true;
      }
    }

    const name = String(a.name || '').toLowerCase();
    const desc = String(a.description || '').toLowerCase();

    // In-class work, worksheets, physical posterboards, in-person quizzes & tests
    const inClassKeywords = /\b(classwork|cw|poster|posterboard|worksheet|in[-\s]?class|warmup|warm[-\s]?up|exit ticket|bellringer|bell ringer|station|stations|binder check|notebook check|presentation|socratic|discussion in class|lab stations|lab report in class|quiz|test|exam|midterm|frq|mock exam|assessment|quest)\b/i;
    if (inClassKeywords.test(name)) return true;
    if (/\b(turn in paper|on paper|hand in to teacher|in class|bring to class|poster board|physical copy)\b/i.test(desc)) return true;

    return false;
  }

  function isActualAssessment(a) {
    if (!a) return false;
    const name = String(a.name || '').toLowerCase();
    const group = String(a.group_name || '').toLowerCase();

    // Explicit non-assessments: homework, reading, problem sets, worksheets, practice, projects, brochures, handouts, notes
    if (/\b(homework|hw\b|reading|read\b|problem set|practice|worksheet|handout|packet|prep|study guide|notes|brochure|poster)\b/i.test(name)) {
      return false;
    }

    const assessmentRegex = /\b(test|quiz|exam|midterm|final|assessment|frq|dbq|saq|quest|mock exam)\b/i;
    return assessmentRegex.test(name) || assessmentRegex.test(group);
  }

  function isInClassAssessment(a) {
    return isActualAssessment(a) && (isInClassOrPaperWork(a) || a.no_online_submission === true);
  }

  function isPastInClassAssessment(a, referenceTime = Date.now()) {
    if (!isInClassOrPaperWork(a) && a.no_online_submission !== true) return false;
    const due = a.effective_due_at || a.due_at;
    if (!due) return false;
    const dueMs = new Date(due).getTime();
    if (Number.isNaN(dueMs)) return false;
    // If due date has passed, in-class assignment/test concluded
    return referenceTime > dueMs;
  }

  function parseAssignmentNaa(assignment) {
    const text = `${assignment.name || ''} ${stripHtml(assignment.description || '')}`;
    const refYear = assignment.due_at ? new Date(assignment.due_at).getFullYear() : new Date().getFullYear();

    const mDate = text.match(/\bNAA\s+(?:Date\s+)?(?:@\s*[\d:]+\s*(?:am|pm)?\s*)?(\d{1,2})\/(\d{1,2})\b/i) ||
                  text.match(/\bNAA\s*:\s*(\d{1,2})\/(\d{1,2})\b/i) ||
                  text.match(/\bNot\s+Accept(?:ed|able)\s+After\s+(\d{1,2})\/(\d{1,2})\b/i);
    if (mDate) {
      const month = Number(mDate[1]);
      const day = Number(mDate[2]);
      return makeBellAlignedIso(refYear, month, day, assignment.course_id, 'start');
    }
    return null;
  }

  function toggleInClassRetake(id) {
    const key = String(id);
    if (!state.inClassRetakeIds) state.inClassRetakeIds = new Set();
    if (state.inClassRetakeIds.has(key)) {
      state.inClassRetakeIds.delete(key);
      showToast('Marked as taken in class.');
    } else {
      state.inClassRetakeIds.add(key);
      state.checkedIds.delete(key);
      setStoredItem('localStorage', 'atelier_checked_ids', JSON.stringify(Array.from(state.checkedIds)));
      showToast('Moved to active queue: Absent / Retake Needed.');
    }
    setStoredItem('localStorage', 'slated_inclass_retakes', JSON.stringify(Array.from(state.inClassRetakeIds)));
    renderAll();
  }

  function extractRequiredSupplies(assignment, course) {
    const supplies = [];
    const name = String(assignment.name || '');
    const desc = stripHtml(assignment.description || '');
    const courseName = course ? String(course.name || '') : '';
    const combined = `${name} ${desc} ${courseName}`.toLowerCase();

    const isChemistry = /chemistry/i.test(courseName);
    const isCalculus = /calculus/i.test(courseName) || /derivative|implicit|logarithmic/i.test(combined);

    // 1. Chemistry Lab Safety:
    // Chemistry department policy provides Casio fx-260 scientific calculators, safety goggles, and aprons in room.
    // The only physical requirement students must prepare from home is compliant footwear (closed-toe shoes).
    if (isChemistry && /\b(flame test|wet lab|reaction lab|lab report|experiment|lab safety)\b/i.test(combined)) {
      supplies.push({
        tag: 'LAB DRESS CODE',
        name: 'Closed-Toe Shoes',
        reason: 'Mandatory lab dress code (goggles, aprons & Casio fx-260 calculators are provided in room)',
      });
    }

    // 2. Calculus:
    // AP Calculus AB differentiation (derivative rules, logarithmic, implicit) is strictly NON-CALCULATOR per College Board & course policy.
    // We intentionally DO NOT recommend a calculator for analytical differentiation.
    if (!isCalculus && !isChemistry && /\b(calculator|graphing calc|scientific calc|ti-84|ti-89|ti-nspire)\b/i.test(combined)) {
      supplies.push({
        tag: 'EQUIPMENT',
        name: 'Graphing Calculator (TI-84/89)',
        reason: 'Quantitative numerical problem sets',
      });
    }

    // 3. Project Displays & Posterboards:
    if (/\b(poster|posterboard|trifold|tri-fold|6-panel|butcher paper)\b/i.test(combined)) {
      supplies.push({
        tag: 'PROJECT DISPLAY',
        name: 'Posterboard / Trifold Sheet',
        reason: 'Physical project display',
      });
    }

    // 4. Physical Art / Design Materials:
    if (/\b(marker|markers|colored\s*pencil|colored\s*pencils|crayons?|color-code)\b/i.test(combined) ||
        /\b(columbian exchange pbl|columbian exchange.*menu|colonial recruitment brochure|east asia mini-pbl)\b/i.test(combined)) {
      supplies.push({
        tag: 'MATERIALS',
        name: 'Colored Pencils / Markers',
        reason: 'Handmade menu, brochure layout, or visual project',
      });
    }

    // 5. Separate Sheet / Notebook Paper for SAQs & Hardcopy:
    if (/\b(separate\s*sheet|notebook\s*paper|loose[\s-]leaf|hardcopy)\b/i.test(combined) ||
        /\b(colonial recruitment brochure|multipliers.*ad\s*&\s*as)\b/i.test(combined)) {
      supplies.push({
        tag: 'PAPER',
        name: 'Notebook Paper (Separate Sheet)',
        reason: 'Handwritten SAQs or hardcopy turn-in',
      });
    }

    // 6. Charged Device (Laptop / Chromebook):
    if (/\b(google\s*doc|google\s*slides|google\s*form|codehs|gizmos|prezi|reviewecon|webquest)\b/i.test(combined) ||
        /\b(krugman modules|average 4 ways|complex numbers|speech)\b/i.test(combined)) {
      supplies.push({
        tag: 'DEVICE',
        name: 'Charged Laptop / Chromebook',
        reason: 'Google Forms, interactive simulations, or programming environment',
      });
    }

    // 7. Course Texts & Handouts:
    if (/\b(krugman)\b/i.test(combined)) {
      supplies.push({
        tag: 'TEXTBOOK',
        name: 'Krugman Macroeconomics Text',
        reason: 'Module readings',
      });
    } else if (/\b(bentley)\b/i.test(combined)) {
      supplies.push({
        tag: 'TEXTBOOK',
        name: 'Bentley Traditions & Encounters',
        reason: 'Unit 4 chapter readings',
      });
    } else if (/\b(born a crime)\b/i.test(combined)) {
      supplies.push({
        tag: 'NOVEL',
        name: 'Born a Crime (Trevor Noah)',
        reason: 'Reading log',
      });
    } else if (/\b(novel\s*night|night\s*by\s*elie|elie\s*wiesel)\b/i.test(combined) || (courseName.includes('English') && /\bnight\b/i.test(combined))) {
      supplies.push({
        tag: 'NOVEL',
        name: 'Night (Elie Wiesel)',
        reason: 'Socratic seminar preparation',
      });
    }

    return supplies;
  }

  function getTopicAccelerators(assignment, course) {
    const guides = [];
    const name = String(assignment.name || '');
    const desc = stripHtml(assignment.description || '');
    const courseName = course ? String(course.name || '') : '';
    const combined = `${name} ${desc} ${courseName}`.toLowerCase();

    // 1. AP World History
    if (/world history/i.test(courseName) || /columbian exchange|bentley|transoceanic|maritime|mughal|ottoman|safavid|qing|tokugawa/i.test(combined)) {
      if (/columbian exchange/i.test(combined)) {
        guides.push({
          title: "Heimler's History: The Columbian Exchange (Topic 4.3)",
          url: "https://www.youtube.com/watch?v=2T_W_v1E15Y",
          type: "Video Guide (6m)",
          source: "YouTube",
        });
        guides.push({
          title: "Fiveable AP World Unit 4 Columbian Exchange Study Guide",
          url: "https://fiveable.me/ap-world/unit-4/columbian-exchange/study-guide/E40c2u8D3v",
          type: "Cram Sheet",
          source: "Fiveable",
        });
        guides.push({
          title: "Gilder Lehrman: The Columbian Exchange Primary Sources",
          url: "https://www.gilderlehrman.org/history-resources/essays/columbian-exchange",
          type: "Primary Sources",
          source: "Gilder Lehrman",
        });
      } else {
        guides.push({
          title: "Heimler's History AP World Unit 3 & 4 Playlist",
          url: "https://www.youtube.com/playlist?list=PLEHRHjICEfDXv0sD99H7S9j9N99w9X9q9",
          type: "Topic Review",
          source: "YouTube",
        });
        guides.push({
          title: "Freeman-Pedia Unit 4: Transoceanic Interconnections Map",
          url: "https://www.freeman-pedia.com/earlymodern",
          type: "Visual Map",
          source: "Freeman-Pedia",
        });
      }
    }

    // 2. AP Calculus AB
    if (/calculus/i.test(courseName) || /derivative|implicit|logarithmic|chain rule|product rule|quotient rule/i.test(combined)) {
      if (/logarithmic/i.test(combined)) {
        guides.push({
          title: "Paul's Online Math Notes: Logarithmic Differentiation Worked Steps",
          url: "https://tutorial.math.lamar.edu/Classes/CalcI/LogDiff.aspx",
          type: "Worked Examples",
          source: "Lamar Univ",
        });
        guides.push({
          title: "Khan Academy: Logarithmic Differentiation Practice",
          url: "https://www.khanacademy.org/math/ap-calculus-ab/ab-differentiation-2-new/ab-2-10/v/logarithmic-differentiation",
          type: "Practice Problems",
          source: "Khan Academy",
        });
        guides.push({
          title: "Symbolab: Step-by-Step Derivative Calculator",
          url: "https://www.symbolab.com/solver/derivative-calculator",
          type: "Step Checker",
          source: "Symbolab",
        });
      } else if (/implicit/i.test(combined)) {
        guides.push({
          title: "Paul's Online Math Notes: Implicit Differentiation",
          url: "https://tutorial.math.lamar.edu/Classes/CalcI/ImplicitDiff.aspx",
          type: "Worked Examples",
          source: "Lamar Univ",
        });
        guides.push({
          title: "3Blue1Brown: Visualizing the Chain Rule & Implicit Diff",
          url: "https://www.3blue1brown.com/lessons/chain-rule",
          type: "Visual Intuition",
          source: "3Blue1Brown",
        });
      } else {
        guides.push({
          title: "Paul's Online Math Notes: Derivative Rules Reference Sheet",
          url: "https://tutorial.math.lamar.edu/cheat_sheets.aspx",
          type: "Reference Sheet",
          source: "Lamar Univ",
        });
        guides.push({
          title: "Khan Academy: AP Calculus AB Differentiation Unit",
          url: "https://www.khanacademy.org/math/ap-calculus-ab/ab-differentiation-1-new",
          type: "Interactive Practice",
          source: "Khan Academy",
        });
      }
    }

    // 3. AP Macroeconomics
    if (/macro/i.test(courseName) || /multiplier|krugman|aggregate demand|sras|fiscal policy|mpc|mps/i.test(combined)) {
      guides.push({
        title: "ReviewEcon: Multipliers Interactive Graph & Simulation",
        url: "https://www.reviewecon.com/spending-multiplier",
        type: "Interactive Tool",
        source: "ReviewEcon",
      });
      guides.push({
        title: "Jacob Clifford (ACDC Econ): Spending & Tax Multipliers (6m)",
        url: "https://www.youtube.com/watch?v=3g8Cviq5tU8",
        type: "Video Lesson",
        source: "YouTube",
      });
      guides.push({
        title: "ReviewEcon: AD/AS Aggregate Demand & Supply Shifters",
        url: "https://www.reviewecon.com/adas-model",
        type: "Graph Guide",
        source: "ReviewEcon",
      });
    }

    // 4. Chemistry Honors
    if (/chemistry/i.test(courseName) || /gizmos|isotope|atomic mass|bohr|electron config|periodic trends|flame test/i.test(combined)) {
      if (/periodic trend/i.test(combined)) {
        guides.push({
          title: "The Organic Chemistry Tutor: Periodic Trends Video",
          url: "https://www.youtube.com/watch?v=hePb00CboSs",
          type: "Video Guide (15m)",
          source: "YouTube",
        });
        guides.push({
          title: "Tyler DeWitt: Periodic Trends Explained Intuitively",
          url: "https://www.youtube.com/watch?v=0tP6bV89vig",
          type: "Visual Concept",
          source: "YouTube",
        });
      } else {
        guides.push({
          title: "Tyler DeWitt Chemistry Foundations Playlist",
          url: "https://www.youtube.com/c/TylerDeWitt",
          type: "Step-by-Step Help",
          source: "YouTube",
        });
        guides.push({
          title: "NCDPI Chemistry Reference Tables (Official PDF)",
          url: "https://www.dpi.nc.gov/documents/accountability/testing/chemistry-reference-tables",
          type: "Reference Tables",
          source: "NCDPI",
        });
      }
    }

    // 5. English II Honors
    if (/english/i.test(courseName) || /mandela|trevor noah|born a crime|apartheid|socratic|night|speech/i.test(combined)) {
      if (/prepared to die|mandela/i.test(combined)) {
        guides.push({
          title: "Nelson Mandela Rivonia Trial 'I am Prepared to Die' Speech Audio & Full Text",
          url: "https://www.nelsonmandela.org/news/entry/i-am-prepared-to-die",
          type: "Historical Speech",
          source: "Mandela Foundation",
        });
        guides.push({
          title: "Purdue OWL: Rhetorical Analysis (Ethos, Pathos, Logos Framework)",
          url: "https://owl.purdue.edu/owl/general_writing/academic_writing/rhetorical_situation/index.html",
          type: "Analysis Toolkit",
          source: "Purdue OWL",
        });
      } else if (/born a crime/i.test(combined)) {
        guides.push({
          title: "LitCharts: Born a Crime Themes, Characters & Chapter Summaries",
          url: "https://www.litcharts.com/lit/born-a-crime",
          type: "Chapter Guide",
          source: "LitCharts",
        });
      }
    }

    // 6. AP Computer Science A
    if (/computer science|csa|java/i.test(courseName) || /codehs|java|class|complex numbers|average 4 ways/i.test(combined)) {
      guides.push({
        title: "CodingBat Java: AP CS A Practice Problems",
        url: "https://codingbat.com/java",
        type: "Interactive Coding",
        source: "CodingBat",
      });
      guides.push({
        title: "Practice-It: University of Washington Building Java Programs",
        url: "https://practiceit.cs.washington.edu/",
        type: "Exercise Bank",
        source: "Univ of Washington",
      });
      guides.push({
        title: "Oracle Official Java 17 Standard Library API Docs",
        url: "https://docs.oracle.com/en/java/javase/17/docs/api/",
        type: "Official Reference",
        source: "Oracle",
      });
    }

    // 7. Spanish II Honors
    if (/spanish/i.test(courseName) || /verbos|conjugat|pelicula/i.test(combined)) {
      guides.push({
        title: "SpanishDict: Complete Verb Conjugator & Irregular Chart",
        url: "https://www.spanishdict.com/conjugation",
        type: "Verb Conjugator",
        source: "SpanishDict",
      });
      guides.push({
        title: "StudySpanish.com: Preterite vs Imperfect Grammar Guide",
        url: "https://studyspanish.com/grammar/lessons/pret1",
        type: "Grammar Lesson",
        source: "StudySpanish",
      });
    }

    return guides;
  }

  function getAssignmentDeliverableChecklist(a) {
    const name = String(a.name || '').toLowerCase();
    const desc = stripHtml(a.description || '').toLowerCase();
    const combined = `${name} ${desc}`;

    if (/columbian exchange pbl|columbian exchange.*menu/i.test(combined)) {
      return [
        'Physical 4-page handmade Food Truck Menu (no digital printouts).',
        'At least 3 Old World dishes + 3 New World dishes + 3 Mixed dishes.',
        'At least 2 sides/drinks per entrée.',
        'Minimum of 2 academic MLA source citations on back.',
      ];
    }
    if (/columbian exchange.*posterboard/i.test(combined)) {
      return [
        '4-quadrant posterboard (Flora, Fauna, Diseases, Demographic shifts).',
        'Visual illustrations + color-coded origin routes (East-to-West vs West-to-East).',
        'In-class project completed across 2 sessions (30m each).',
      ];
    }
    if (/colonial recruitment brochure/i.test(combined)) {
      return [
        'Handmade 6-panel trifold brochure (New Spain, Peru, Mass Bay, or New France).',
        'Clear push and pull factors for prospective colonists.',
        'Separate sheet: 4-question Global Empire Check SAQs.',
      ];
    }
    if (/multipliers.*ad\s*&\s*as/i.test(combined)) {
      return [
        'Complete printed handout (3 MPC/MPS tables + 11 multipliers + 5 AD/AS graphs).',
        'Complete ReviewEcon review games and take high-resolution screenshot.',
        'Upload ReviewEcon score proof (.PNG or .JPG only — no .HEIC) + submit hardcopy in class.',
      ];
    }
    if (/krugman\s*modules?\s*19[-–]21/i.test(combined)) {
      return [
        'Read Krugman textbook Modules 19–21 (~30 pages on AD-AS Equilibrium & Fiscal Policy).',
        'Submit the Google Form check before the beginning of next class period (NAA).',
      ];
    }
    if (/prepared to die speech/i.test(combined)) {
      return [
        'Read Nelson Mandela Rivonia Trial speech (pages 5–7).',
        'Answer all 6 reflection questions in a Google Doc.',
        'Ensure "Edit Access" is granted to teacher before turn-in.',
      ];
    }
    if (/flame test lab report/i.test(combined)) {
      return [
        'Follow "How to Write a Chemistry Lab Report" formal template.',
        'Include: Purpose, Electron excitation theory, Flame observations table, and Error analysis.',
        'Must be submitted before the last class before holiday break.',
      ];
    }
    if (/complex numbers/i.test(combined)) {
      return [
        'Implement full ComplexNumber Java class in CodeHS.',
        'Methods: add(), subtract(), multiply(), divide(), abs(), and formatted toString().',
        'Run all unit test cases to verify string formatting before final submission.',
      ];
    }

    return null;
  }

  function buildCourseContextMap() {
    const now = Date.now();
    const dayMs = 86400 * 1000;
    const map = {};

    for (const course of state.courses) {
      const cid = String(course.id);
      const existing = state.courseContexts[cid] || {};
      const courseAssigns = state.assignments.filter((a) => String(a.course_id) === cid);
      const courseAnns = state.announcements.filter(
        (ann) => String(ann.context_code || '').replace(/^course_/, '') === cid
      );
      const modules = Array.isArray(existing.modules)
        ? existing.modules
        : Array.isArray(course.modules)
        ? course.modules
        : [];
      const groups = Array.isArray(existing.groups)
        ? existing.groups
        : Array.isArray(course.groups)
        ? course.groups
        : [];

      const completedUnitNums = new Set();
      let maxCurrentUnitNum = null;
      let latestActivityMs = 0;

      for (const a of courseAssigns) {
        const dueMs = a.due_at ? new Date(a.due_at).getTime() : 0;
        const createdMs = a.created_at ? new Date(a.created_at).getTime() : 0;
        const updatedMs = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const itemTouch = Math.max(dueMs, createdMs, updatedMs);
        if (itemTouch > latestActivityMs && itemTouch <= now + 60 * dayMs) {
          latestActivityMs = itemTouch;
        }

        const unitNum = extractUnitNumber(a.name) || extractUnitNumber(a.group_name);

        if (unitNum != null) {
          const isUnitTestOrSurvey = /\b(post\s*test|unit\s*\d+\s*test|exam|assessment|final\s*seminar)\b/i.test(
            a.name
          );
          if (isUnitTestOrSurvey && ((dueMs > 0 && dueMs < now - dayMs) || a.is_submitted)) {
            completedUnitNums.add(unitNum);
          }

          const isRecentOrFuture =
            (dueMs > 0 && dueMs >= now - 12 * dayMs) ||
            (createdMs > 0 && createdMs >= now - 14 * dayMs);
          if (isRecentOrFuture) {
            if (maxCurrentUnitNum == null || unitNum > maxCurrentUnitNum) {
              maxCurrentUnitNum = unitNum;
            }
          }
        }
      }

      for (const ann of courseAnns.slice(0, 6)) {
        const postedMs = ann.posted_at ? new Date(ann.posted_at).getTime() : 0;
        if (postedMs >= now - 18 * dayMs) {
          const u = extractUnitNumber(`${ann.title} ${ann.clean_text || ann.message || ''}`);
          if (u != null && (maxCurrentUnitNum == null || u > maxCurrentUnitNum)) {
            maxCurrentUnitNum = u;
          }
        }
      }

      if (maxCurrentUnitNum != null && maxCurrentUnitNum > 1) {
        for (let u = 1; u < maxCurrentUnitNum; u++) {
          completedUnitNums.add(u);
        }
      }

      let activeUnitLabel = '';
      if (modules.length > 0) {
        const substantiveModules = modules.filter(
          (m) => !/^(welcome|resources|important|course info|syllabus|reference)/i.test(m.name)
        );
        if (substantiveModules.length > 0) {
          activeUnitLabel = substantiveModules[substantiveModules.length - 1].name;
        } else {
          activeUnitLabel = modules[modules.length - 1].name;
        }
      }
      if (!activeUnitLabel && maxCurrentUnitNum != null) {
        activeUnitLabel = `Unit ${maxCurrentUnitNum}`;
      }
      if (!activeUnitLabel && courseAnns.length > 0) {
        const latestAnn = courseAnns[0];
        if (/logarithmic|implicit|deriv/i.test(`${latestAnn.title} ${latestAnn.message}`)) {
          activeUnitLabel = 'Derivative Rules & Implicit Diff';
        }
      }

      map[cid] = {
        courseId: course.id,
        modules,
        groups,
        activeUnitLabel: activeUnitLabel || 'Active Term',
        maxCurrentUnitNum,
        completedUnitNums: Array.from(completedUnitNums).sort((a, b) => a - b),
        latestActivityMs: latestActivityMs || now,
      };
    }

    state.courseContexts = map;
  }

  // Connects Teacher Announcements + Assignment Descriptions + School Bell Schedule + Handouts
  function getAnnouncementContextEnrichments() {
    const deadlineOverrides = new Map();
    const virtualAssessments = [];
    const now = Date.now();
    const dayMs = 86400 * 1000;

    // 1. Scan assignment descriptions for embedded NAA dates, "beginning of class" deadlines, and handout specs
    for (const a of state.assignments) {
      const descPlain = stripHtml(a.description || '');
      const nameLower = String(a.name || '').toLowerCase();
      const bell = getCourseBellInfo(a.course_id);
      const refYear = a.due_at ? new Date(a.due_at).getFullYear() : new Date().getFullYear();

      // Check for "Due next class NAA MM/DD" in assignment description (e.g. 4A English II "I am prepared to die speech" -> NAA 11/10 @ 12:53 PM)
      const naaMatch = descPlain.match(/\b(?:due\s+next\s+class\s+)?NAA\s+(\d{1,2})\/(\d{1,2})\b/i);
      if (naaMatch) {
        const m = Number(naaMatch[1]);
        const d = Number(naaMatch[2]);
        const alignedIso = makeBellAlignedIso(refYear, m, d, a.course_id, 'start');
        deadlineOverrides.set(String(a.id), {
          effectiveDueAt: alignedIso,
          badge: `Due ${m}/${d} • ${bell.period} (${bell.startText})`,
          note: `Due at start of ${bell.period} (${bell.startText}${bell.room ? `, Rm ${bell.room}` : ''}) on ${m}/${d} (NAA).`,
        });
      }

      if (/colonial recruitment brochure/i.test(nameLower)) {
        const existing = deadlineOverrides.get(String(a.id)) || {};
        deadlineOverrides.set(String(a.id), {
          effectiveDueAt: existing.effectiveDueAt || a.due_at,
          badge: existing.badge || '6-Panel Trifold + 4 SAQs',
          note: 'Handmade 6-panel trifold brochure (New Spain, Peru, Mass Bay, or New France) + 4-question Global Empire Check on a separate sheet. Pacing: 25m research • 10m plan • 65m build • 20m SAQs.',
        });
      }

      if (/multipliers.*ad\s*&\s*as/i.test(nameLower)) {
        const existing = deadlineOverrides.get(String(a.id)) || {};
        deadlineOverrides.set(String(a.id), {
          effectiveDueAt: existing.effectiveDueAt || a.due_at,
          badge: existing.badge || 'PDF + ReviewEcon (.PNG/.JPG)',
          note: 'Complete 3 MPC/MPS tables, 11 GDP multiplier problems, and 5 AD/AS graphs + attach ReviewEcon screenshot (.PNG or .JPG only — no .HEIC).',
          studyDeckLink: 'macro_mult',
        });
      }

      if (/krugman\s*modules?\s*19[-–]21/i.test(nameLower)) {
        const existing = deadlineOverrides.get(String(a.id)) || {};
        deadlineOverrides.set(String(a.id), {
          effectiveDueAt: existing.effectiveDueAt || a.due_at,
          badge: existing.badge || 'Modules 19–21 + Form',
          note: 'Covers Krugman Modules 19–21 (Equilibrium in AD–AS & Fiscal Policy, ~30 pages) + Google Form check. Recorded in Infinite Campus.',
          studyDeckLink: 'macro_mult',
        });
      }
    }

    // 2. Scan Teacher Announcements and align with Course Bell Schedule
    for (const ann of state.announcements) {
      const courseId = String(ann.context_code || '').replace(/^course_/, '');
      const postedMs = ann.posted_at ? new Date(ann.posted_at).getTime() : 0;
      if (!postedMs || now - postedMs > 21 * dayMs) continue;

      const text = `${ann.title || ''} ${ann.clean_text || stripHtml(ann.message || '')}`;
      const bell = getCourseBellInfo(courseId);
      const postedYear = new Date(postedMs).getFullYear();

      // 1B AP World History: Columbian Exchange Menu Due Date -> Mon 11/9 @ 7:25 AM (Start of 1B)
      if (/columbian exchange/i.test(text) && /\b11\/9\b/i.test(text)) {
        const matchingAssigns = state.assignments.filter(
          (a) =>
            String(a.course_id) === courseId && /columbian exchange/i.test(String(a.name || ''))
        );
        for (const matchingAssign of matchingAssigns) {
          const isPblMenu = /pbl/i.test(matchingAssign.name);
          if (isPblMenu) {
            const newDueIso = makeBellAlignedIso(postedYear, 11, 9, courseId, 'start');
            deadlineOverrides.set(String(matchingAssign.id), {
              effectiveDueAt: newDueIso,
              badge: `Due Mon 11/9 • ${bell.period} (${bell.startText})`,
              note: `Due at the start of ${bell.period} (${bell.startText}) on B-Day Mon 11/9 (NAA). Submit physical 4-page handmade Food Truck menu (3×3 Old/New/Mixed World rule + 2 sides per entrée + 2 sources).`,
              announcementUrl: ann.html_url,
              studyDeckLink: 'world_pbl',
            });
          } else {
            deadlineOverrides.set(String(matchingAssign.id), {
              effectiveDueAt: matchingAssign.due_at,
              badge: 'Due Mon 11/9 • 2 Class Sessions',
              note: 'In-class 4-quadrant Columbian Exchange posterboard project (2 sessions × 30m). Food Truck Menu PBL is due at 7:25 AM.',
              announcementUrl: ann.html_url,
              studyDeckLink: 'world_pbl',
            });
          }
        }
      }

      // 2B AP Calculus AB: BIG Quiz on Monday 11/9 -> Start of 2B (8:58 AM)
      if (/plan on big quiz on monday 9th/i.test(text)) {
        virtualAssessments.push({
          id: `ann_quiz_${ann.id}_nov9`,
          course_id: Number(courseId) || courseId,
          name: 'BIG Quiz: All 20 Derivative Rules & Logarithmic Diff',
          due_at: makeBellAlignedIso(postedYear, 11, 9, courseId, 'start'),
          points_possible: null,
          html_url: ann.html_url,
          description: `${bell.period} (${bell.rangeText}${bell.room ? `, Rm ${bell.room}` : ''}). Covers all 20 derivative rules, implicit differentiation, and logarithmic differentiation.`,
          is_announcement_event: true,
          context_badge: `${bell.period} • ${bell.startText}`,
          attachments: ann.attachments || [],
          study_deck_link: 'calc_log',
        });
      }

      // 2B AP Calculus AB: Derivative Rules Test on Monday 11/16 -> Start of 2B (8:58 AM)
      if (/plan on deriv rules test on mon 16th/i.test(text)) {
        virtualAssessments.push({
          id: `ann_test_${ann.id}_nov16`,
          course_id: Number(courseId) || courseId,
          name: 'Test: Derivative Rules & Implicit/Logarithmic Differentiation',
          due_at: makeBellAlignedIso(postedYear, 11, 16, courseId, 'start'),
          points_possible: 100,
          html_url: ann.html_url,
          description: `${bell.period} (${bell.rangeText}${bell.room ? `, Rm ${bell.room}` : ''}). Full unit test on 20 derivative rules, implicit differentiation, and logarithmic differentiation.`,
          is_announcement_event: true,
          context_badge: `${bell.period} • ${bell.startText}`,
          attachments: ann.attachments || [],
          study_deck_link: 'calc_implicit',
        });
      }

      // 4B AP Macroeconomics: Quiz on Monday 11/9 -> Start of 4B (12:53 PM)
      if (/let's take a quiz/i.test(ann.title || '') && /3\.1\s*aggregate demand/i.test(text)) {
        virtualAssessments.push({
          id: `ann_quiz_${ann.id}_macro`,
          course_id: Number(courseId) || courseId,
          name: 'Quiz: 3.1 Aggregate Demand, 3.2 Multipliers & 3.3 SRAS',
          due_at: makeBellAlignedIso(postedYear, 11, 9, courseId, 'start'),
          points_possible: null,
          html_url: ann.html_url,
          description: `${bell.period} (${bell.rangeText} on B-Day Mon 11/9). Covers AD shifters, MPC/MPS spending & tax multipliers, and Short-Run Aggregate Supply.`,
          is_announcement_event: true,
          context_badge: `${bell.period} • ${bell.startText}`,
          attachments: ann.attachments || [],
          study_deck_link: 'macro_mult',
        });
      }
    }

    return { deadlineOverrides, virtualAssessments };
  }

  function evaluateAssignmentContext(a, deadlineOverrides) {
    const now = Date.now();
    const dayMs = 86400 * 1000;
    const cid = String(a.course_id || '');
    const ctx = state.courseContexts[cid] || {
      activeUnitLabel: 'Current Unit',
      maxCurrentUnitNum: null,
      completedUnitNums: [],
      latestActivityMs: now,
    };

    const override = deadlineOverrides ? deadlineOverrides.get(String(a.id)) : null;
    const effectiveDueAt = override ? override.effectiveDueAt : a.due_at;
    const dueMs = effectiveDueAt ? new Date(effectiveDueAt).getTime() : null;
    const createdMs = a.created_at ? new Date(a.created_at).getTime() : 0;
    const updatedMs = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const lastTouchMs = Math.max(createdMs, updatedMs);

    const title = String(a.name || '').trim();
    const groupName = String(a.group_name || '').trim();
    const unitNum = extractUnitNumber(title) || extractUnitNumber(groupName);

    if (a.is_custom || a.is_announcement_event) {
      return {
        isActiveContext: true,
        isArchivedContext: false,
        effectiveDueAt,
        contextBadge: a.context_badge || (a.is_custom ? 'Personal Reminder' : 'Active'),
        contextNote: override ? override.note : '',
        studyDeckLink: a.study_deck_link || (override && override.studyDeckLink) || null,
      };
    }

    const isCompletedUnit =
      (unitNum != null && ctx.completedUnitNums.includes(unitNum)) ||
      /^1st\s*qtr$/i.test(groupName);

    const isFirstDayOrOrientation =
      /\b(first day|day one|questionnaire|scavenger hunt|trial assignment|syllabus|welcome)\b/i.test(
        title
      ) || /^emergency lesson plans$/i.test(groupName);

    const isZeroPointPlanDoc =
      (a.points_possible === 0 || a.points_possible === null) &&
      /\b(unit\s*\d+\s*plan|practice needed document)\b/i.test(title);

    if (!effectiveDueAt || Number.isNaN(dueMs)) {
      if (isFirstDayOrOrientation) {
        return {
          isActiveContext: false,
          isArchivedContext: true,
          effectiveDueAt: null,
          contextBadge: 'Archived • First-Day / Orientation',
          contextNote: 'Outdated beginning-of-semester activity.',
          studyDeckLink: null,
        };
      }
      if (isCompletedUnit) {
        return {
          isActiveContext: false,
          isArchivedContext: true,
          effectiveDueAt: null,
          contextBadge: unitNum
            ? `Archived • Unit ${unitNum} Completed`
            : 'Archived • Past Quarter',
          contextNote: `Class has moved to ${ctx.activeUnitLabel}.`,
          studyDeckLink: null,
        };
      }
      if (isZeroPointPlanDoc) {
        return {
          isActiveContext: false,
          isArchivedContext: true,
          effectiveDueAt: null,
          contextBadge: 'Reference Plan Doc (0 pts)',
          contextNote: 'Course unit reference schedule.',
          studyDeckLink: null,
        };
      }

      const referenceNow = Math.max(now, ctx.latestActivityMs);
      const ageDays = lastTouchMs > 0 ? (referenceNow - lastTouchMs) / dayMs : 999;

      if (ageDays > 12) {
        const postedDateLabel =
          createdMs > 0
            ? new Date(createdMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : 'Earlier Term';
        return {
          isActiveContext: false,
          isArchivedContext: true,
          effectiveDueAt: null,
          contextBadge: `Archived • Posted ${postedDateLabel}`,
          contextNote: 'Undated item from an earlier module.',
          studyDeckLink: null,
        };
      }

      const postedRecentLabel =
        createdMs > 0
          ? `Posted ${new Date(createdMs).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}`
          : 'Current Unit';
      return {
        isActiveContext: true,
        isArchivedContext: false,
        effectiveDueAt: null,
        contextBadge: `${ctx.activeUnitLabel} • ${postedRecentLabel}`,
        contextNote: override ? override.note : '',
        studyDeckLink: (override && override.studyDeckLink) || null,
      };
    }

    const diffDays = (dueMs - now) / dayMs;

    if (diffDays >= 0) {
      return {
        isActiveContext: true,
        isArchivedContext: false,
        effectiveDueAt,
        contextBadge: override
          ? override.badge
          : unitNum
          ? `Unit ${unitNum}`
          : groupName || ctx.activeUnitLabel,
        contextNote: override ? override.note : '',
        studyDeckLink: (override && override.studyDeckLink) || null,
      };
    }

    if ((isCompletedUnit && diffDays < -4) || diffDays < -12) {
      return {
        isActiveContext: false,
        isArchivedContext: true,
        effectiveDueAt,
        contextBadge:
          isCompletedUnit && unitNum
            ? `Archived • Unit ${unitNum} Completed`
            : 'Archived • Past Unit',
        contextNote: '',
        studyDeckLink: null,
      };
    }

    return {
      isActiveContext: true,
      isArchivedContext: false,
      effectiveDueAt,
      contextBadge: override
        ? override.badge
        : unitNum
        ? `Unit ${unitNum}`
        : groupName || ctx.activeUnitLabel,
      contextNote: override ? override.note : '',
      studyDeckLink: (override && override.studyDeckLink) || null,
    };
  }

  // -------------------------------------------------------------------------
  // 4. 25-Minute Study Focus Timer
  // -------------------------------------------------------------------------
  function updateFocusTimerDisplay() {
    if (!els.focusTimerBar) return;
    if (!state.focusTimer.active) {
      els.focusTimerBar.classList.add('hidden');
      els.focusTimerBar.classList.remove('flex');
      if (state.authenticated && state.credentials.configured) {
        els.startQuickFocusBtn.classList.remove('hidden');
      }
      return;
    }
    els.startQuickFocusBtn.classList.add('hidden');
    els.focusTimerBar.classList.remove('hidden');
    els.focusTimerBar.classList.add('flex');
    els.focusTimerLabel.textContent = state.focusTimer.label;
    const mins = Math.floor(state.focusTimer.secondsLeft / 60);
    const secs = state.focusTimer.secondsLeft % 60;
    els.focusTimerClock.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    els.focusTimerToggleBtn.textContent = state.focusTimer.paused ? 'Resume' : 'Pause';
  }

  function startFocusTimer(taskName = '25m Study Session') {
    clearInterval(state.focusTimer.intervalId);
    state.focusTimer.active = true;
    state.focusTimer.paused = false;
    state.focusTimer.secondsLeft = 25 * 60;
    state.focusTimer.label = taskName;
    updateFocusTimerDisplay();
    showToast(`Started 25-minute focus timer: ${taskName}`);

    state.focusTimer.intervalId = setInterval(() => {
      if (state.focusTimer.paused) return;
      state.focusTimer.secondsLeft -= 1;
      if (state.focusTimer.secondsLeft <= 0) {
        clearInterval(state.focusTimer.intervalId);
        state.focusTimer.active = false;
        showToast(`Focus session complete: ${state.focusTimer.label}!`);
      }
      updateFocusTimerDisplay();
    }, 1000);
  }

  // -------------------------------------------------------------------------
  // 5. Command Palette (Cmd+K / Ctrl+K Spotlight)
  // -------------------------------------------------------------------------
  function openCmdPalette() {
    if (!els.cmdPaletteBackdrop) return;
    els.cmdPaletteBackdrop.classList.remove('hidden');
    els.cmdPaletteInput.value = '';
    state.cmdPaletteSelectedIndex = 0;
    renderCmdPaletteResults('');
    setTimeout(() => els.cmdPaletteInput.focus(), 20);
  }

  function closeCmdPalette() {
    if (!els.cmdPaletteBackdrop) return;
    els.cmdPaletteBackdrop.classList.add('hidden');
  }

  function jumpToTaskInQueue(id) {
    closeCmdPalette();
    const aid = String(id);
    const cardEl = document.getElementById(`task-card-${aid}`);
    if (cardEl) {
      const bucket = cardEl.closest('.queue-bucket');
      if (bucket && bucket.classList.contains('is-collapsed')) {
        const bucketId = bucket.getAttribute('data-bucket');
        if (bucketId) state.collapsedBuckets.delete(bucketId);
        bucket.classList.remove('is-collapsed');
      }
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      cardEl.classList.remove('highlight-pulse');
      void cardEl.offsetWidth;
      cardEl.classList.add('highlight-pulse');
      setTimeout(() => cardEl.classList.remove('highlight-pulse'), 2200);
      return;
    }
    state.assignmentHorizon = 'all';
    state.selectedCourseId = 'all';
    if (els.courseFilterSelect) els.courseFilterSelect.value = 'all';
    renderAll();
    setTimeout(() => {
      const el = document.getElementById(`task-card-${aid}`);
      if (el) {
        const b = el.closest('.queue-bucket');
        if (b) b.classList.remove('is-collapsed');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 2200);
      }
    }, 120);
  }

  function renderCmdPaletteResults(query) {
    if (!els.cmdPaletteResults) return;
    const q = String(query || '').trim().toLowerCase();
    const items = [];

    // 1. Quick Navigation & Secondary Tool Drawers
    items.push(
      {
        type: 'Lab',
        title: 'Open Study & Symbolic Answer Equivalence Lab',
        sub: 'Verify derivative steps, macro multipliers, or Food Truck PBL with scratchpad',
        action: () => {
          closeCmdPalette();
          openStudyLabDrawer('calc_log', 0);
        },
      },
      {
        type: 'Briefings',
        title: 'Open Teacher Briefings Center',
        sub: `${state.announcements.length} teacher updates & downloadable solution keys`,
        action: () => {
          closeCmdPalette();
          openBriefingsDrawer('all');
        },
      },
      {
        type: 'Briefings',
        title: 'Open Saved Teacher Briefings Vault',
        sub: `${state.savedBriefingIds.size} pinned summaries and study guides`,
        action: () => {
          closeCmdPalette();
          openBriefingsDrawer('saved');
        },
      },
      {
        type: 'Vault',
        title: 'Open Digital Textbooks & Resource Vault',
        sub: `${state.resources.length} chapter PDFs, syllabi, and practice problem keys`,
        action: () => {
          closeCmdPalette();
          openResourcesDrawer();
        },
      },
      {
        type: 'Pacing',
        title: 'Open AP World Pacing & Reading Schedule',
        sub: 'Unit 4 Transoceanic Interconnections daily timeline & A/B quizzes',
        action: () => {
          closeCmdPalette();
          openPacingDrawer();
        },
      },
      {
        type: 'Calendar',
        title: 'Open Monthly Schedule Grid',
        sub: 'Interactive monthly deadlines, bell schedules, and exam targets',
        action: () => {
          closeCmdPalette();
          openCalendarDrawer();
        },
      }
    );

    // 2. Focus Timer Controls
    if (state.focusTimer.active) {
      if (state.focusTimer.paused) {
        items.push({
          type: 'Timer',
          title: `Resume Focus Timer (${els.focusTimerClock.textContent} remaining)`,
          sub: state.focusTimer.label,
          action: () => {
            closeCmdPalette();
            state.focusTimer.paused = false;
            updateFocusTimerDisplay();
            showToast('Focus timer resumed.');
          },
        });
      } else {
        items.push({
          type: 'Timer',
          title: `Pause Focus Timer (${els.focusTimerClock.textContent} remaining)`,
          sub: state.focusTimer.label,
          action: () => {
            closeCmdPalette();
            state.focusTimer.paused = true;
            updateFocusTimerDisplay();
            showToast('Focus timer paused.');
          },
        });
      }
      items.push({
        type: 'Timer',
        title: 'End Focus Session',
        sub: state.focusTimer.label,
        action: () => {
          closeCmdPalette();
          clearInterval(state.focusTimer.intervalId);
          state.focusTimer.active = false;
          updateFocusTimerDisplay();
          showToast('Focus timer ended.');
        },
      });
    } else {
      items.push({
        type: 'Timer',
        title: 'Start 25-Minute Study Focus Session',
        sub: 'Pomodoro timer in studio header bar',
        action: () => {
          closeCmdPalette();
          startFocusTimer('25m Deep Focus');
        },
      });
    }

    // 3. Calendar & Sync Actions
    items.push(
      {
        type: 'Sync',
        title: 'Copy iCal Live Feed URL',
        sub: 'Subscribe in Apple Calendar, Google Calendar, or Outlook for auto-updates',
        action: () => {
          closeCmdPalette();
          copyIcalFeedUrl();
        },
      },
      {
        type: 'Sync',
        title: 'Download .ics Calendar File',
        sub: 'Verified RFC 5545 export with all deadlines and bell schedule times',
        action: () => {
          closeCmdPalette();
          downloadIcsCalendar();
        },
      },
      {
        type: 'Sync',
        title: 'Open Google Calendar Web Sync',
        sub: 'Subscribe in a new Google Calendar browser tab',
        action: () => {
          closeCmdPalette();
          openGcalSyncModal();
        },
      }
    );

    // 4. Classes, What-If Grade Labs & Filters
    for (const c of state.courses) {
      const meta = parseCourseMeta(c);
      const avg = computeCourseAverageObject(c.id, true);
      const gradeStr = avg ? ` • ${avg.percent}% (${avg.letterGrade})` : '';

      items.push(
        {
          type: 'Grade Lab',
          title: `${meta.period} • ${meta.title}${gradeStr} — What-If & Target Grade Lab`,
          sub: `${meta.teacher || 'Instructor'} • Calculate hypothetical scores & category weights`,
          action: () => {
            closeCmdPalette();
            openCourseInspector(c.id, 'gradelab');
          },
        },
        {
          type: 'Class',
          title: `${meta.period} • ${meta.title} — Active Unit & Modules`,
          sub: `${meta.teacher || 'Instructor'} • View syllabus summary and course modules`,
          action: () => {
            closeCmdPalette();
            openCourseInspector(c.id, 'overview');
          },
        },
        {
          type: 'Filter',
          title: `Filter Queue: ${meta.title}`,
          sub: 'Show only this course in the active queue feed',
          action: () => {
            closeCmdPalette();
            state.selectedCourseId = String(c.id);
            if (els.courseFilterSelect) els.courseFilterSelect.value = String(c.id);
            renderAll();
            showToast(`Filtered active queue to ${meta.title}`);
          },
        }
      );
    }

    // 5. Active Deadlines (Jump directly to task)
    for (const a of getCombinedAssignments().filter((x) => x.is_active_context && !x.is_archived_context)) {
      const c = getCourseById(a.course_id);
      const meta = c ? parseCourseMeta(c) : { title: 'Task' };
      const due = a.effective_due_at || a.due_at;
      const isDone = isAssignmentDone(a);

      items.push({
        type: 'Deadline',
        title: a.name,
        sub: `${meta.title} • Due ${formatDateTime(due)}${isDone ? ' • Done' : ''} • Jump to task`,
        action: () => {
          jumpToTaskInQueue(a.id);
        },
      });
    }

    // 6. Downloadable Teacher Study Files (.docx / .pdf)
    for (const ann of state.announcements) {
      const sAnn = ensureAnnouncementSummarized(ann);
      if (Array.isArray(sAnn.attachments)) {
        for (const f of sAnn.attachments) {
          items.push({
            type: 'Study File',
            title: `Download Key: ${f.display_name}`,
            sub: `${sAnn.title} (${sAnn.author_name})`,
            action: () => {
              closeCmdPalette();
              const safeUrl = safeHttpUrl(f.url);
              if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
            },
          });
        }
      }
    }

    // 7. Density & Theme Palettes
    items.push({
      type: 'View',
      title: `Toggle Density: ${state.compactView ? 'Switch to Comfortable' : 'Switch to Compact'}`,
      sub: 'Adjust spacing and visual density for list cards',
      action: () => {
        closeCmdPalette();
        toggleCompactView();
      },
    });

    for (const p of [
      { id: 'obsidian', name: 'Obsidian & Vermilion (Dark Studio)' },
      { id: 'paper', name: 'Newsprint & Editorial Ink (Light Paper)' },
      { id: 'midnight', name: 'Midnight Slate & Cobalt (Night Focus)' },
      { id: 'forest', name: 'Forest & Matcha (Calm Study)' },
    ]) {
      items.push({
        type: 'Palette',
        title: `Switch Theme: ${p.name}`,
        sub: 'Studio Color System',
        action: () => {
          applyPalette(p.id);
          closeCmdPalette();
          showToast(`Switched palette to ${p.name}`);
        },
      });
    }

    // 8. Security Audit
    items.push({
      type: 'Security',
      title: 'Inspect Read-Only & AES-256-GCM Security Proof',
      sub: 'Live audit log, encryption proof & panic wipe',
      action: () => {
        closeCmdPalette();
        renderSecurityAuditModal();
        els.privacyModalBackdrop.classList.remove('hidden');
      },
    });

    const filtered = items
      .filter((it) => !q || `${it.type} ${it.title} ${it.sub}`.toLowerCase().includes(q))
      .slice(0, 16);

    if (els.cmdPaletteMatchCount) {
      els.cmdPaletteMatchCount.textContent = `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`;
    }

    if (filtered.length === 0) {
      els.cmdPaletteResults.innerHTML = `<div class="p-6 text-xs text-center secondary-copy">No matching commands, classes, or deadlines. Try another search.</div>`;
      return;
    }

    state.cmdPaletteSelectedIndex = Math.max(0, Math.min(state.cmdPaletteSelectedIndex, filtered.length - 1));

    els.cmdPaletteResults.innerHTML = filtered
      .map(
        (it, idx) => `
        <button
          type="button"
          data-cmd-idx="${idx}"
          class="w-full text-left p-3 tone-surface-2 hover:opacity-90 flex items-center justify-between gap-3 transition ${
            idx === state.cmdPaletteSelectedIndex ? 'cmd-item-active' : ''
          }"
        >
          <div class="min-w-0">
            <p class="text-sm font-bold truncate">${escapeHtml(it.title)}</p>
            <p class="text-xs secondary-copy truncate">${escapeHtml(it.sub)}</p>
          </div>
          <span class="context-tag shrink-0">${escapeHtml(it.type)}</span>
        </button>`
      )
      .join('');

    const activeEl = els.cmdPaletteResults.querySelector('.cmd-item-active');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }

    els.cmdPaletteResults.querySelectorAll('[data-cmd-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-cmd-idx'));
        if (filtered[idx] && filtered[idx].action) filtered[idx].action();
      });
    });
  }

  // -------------------------------------------------------------------------
  // 6. Session & Connection Lifecycle
  // -------------------------------------------------------------------------
  function openTokenModal() {
    if (!els.tokenModalBackdrop) return;
    els.tokenFormError.classList.add('hidden');
    const meta = readStoredJson(
      'slated_google_profile_meta',
      {},
      (value) => value && typeof value === 'object' && !Array.isArray(value)
    );
    if (els.modalGoogleEmailInput && meta.googleEmail) {
      els.modalGoogleEmailInput.value = meta.googleEmail;
    }

    if (state.credentials.configured) {
      els.currentTokenStatusBox.classList.remove('hidden');
      els.maskedTokenLabel.textContent = state.credentials.maskedToken || '••••••••';
      els.currentBaseUrlLabel.textContent = state.credentials.canvasBaseUrl || '';
      els.canvasBaseUrlInput.value =
        state.credentials.canvasBaseUrl || 'https://wcpss.instructure.com';
    } else {
      els.currentTokenStatusBox.classList.add('hidden');
    }
    renderTokenLifecycleUI();
    els.tokenModalBackdrop.classList.remove('hidden');
  }

  function closeTokenModal() {
    if (!els.tokenModalBackdrop) return;
    els.tokenModalBackdrop.classList.add('hidden');
  }

  async function checkSessionAndLoad() {
    const isStaticDeploy =
      window.location.hostname.endsWith('.github.io') ||
      Boolean(window.__ENCRYPTED_CANVAS_SNAPSHOT__);

    if (isStaticDeploy) {
      state.cloudStaticMode = true;
      state.apiOrigin = '';
      renderSavedGoogleBox();

      const savedTokenSession = getStoredItem('sessionStorage', 'atelier_active_token_session');
      if (savedTokenSession && !browserRamCreds) {
        try {
          const parsed = JSON.parse(savedTokenSession);
          if (parsed.canvasApiToken) {
            await unlockCloudWithToken(
              parsed.canvasApiToken,
              parsed.canvasBaseUrl,
              parsed.googleEmail,
              parsed.displayName
            );
            return;
          }
        } catch (error) {
          console.warn('Saved session data is invalid:', error);
        }
      }

      await updateViewForAuthState();
      return;
    }

    const tokenWasErased = enforceTokenExpiry();
    if (tokenWasErased && !state.cloudStaticMode) {
      try {
        const response = await apiFetch('/api/user/credentials', { method: 'DELETE' });
        if (!response.ok) {
          console.warn(`Could not remove expired server credentials (HTTP ${response.status}).`);
        }
      } catch (error) {
        console.warn('Could not remove expired server credentials:', error);
      }
    }
    renderSavedGoogleBox();

    try {
      const res = await apiFetch('/api/auth/session?auto=1');
      if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
        const sessionInfo = await res.json();
        state.cloudStaticMode = false;
        state.apiOrigin = '';
        state.authenticated = Boolean(sessionInfo.authenticated);
        state.hasLocalEnvFileToken = Boolean(sessionInfo.hasLocalEnvFileToken);
        if (state.authenticated && sessionInfo.credentials?.configured) {
          state.user = sessionInfo.user;
          state.credentials = sessionInfo.credentials;
          await updateViewForAuthState();
          return;
        }
        if (els.quickLocalEnvBtn) {
          els.quickLocalEnvBtn.classList.toggle('hidden', !state.hasLocalEnvFileToken);
        }
        await updateViewForAuthState();
        return;
      }
      console.warn(`Application session endpoint returned HTTP ${res.status}.`);
    } catch (error) {
      console.warn('Could not reach the application session endpoint; trying fallback mode:', error);
    }

    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      try {
        const localRes = await fetch('http://localhost:3000/api/auth/session?auto=1', {
          credentials: 'include',
          headers: { 'X-Requested-With': 'CanvasHub' },
        });
        if (localRes.ok) {
          const sessionInfo = await localRes.json();
          state.cloudStaticMode = false;
          state.apiOrigin = 'http://localhost:3000';
          state.authenticated = Boolean(sessionInfo.authenticated);
          state.hasLocalEnvFileToken = Boolean(sessionInfo.hasLocalEnvFileToken);
          if (state.authenticated && sessionInfo.credentials?.configured) {
            state.user = sessionInfo.user;
            state.credentials = sessionInfo.credentials;
            await updateViewForAuthState();
            return;
          }
        } else {
          console.warn(`Local development API returned HTTP ${localRes.status}.`);
        }
      } catch (error) {
        console.warn('Could not reach the local development API:', error);
      }
    }

    state.cloudStaticMode = true;
    const savedTokenSession = getStoredItem('sessionStorage', 'atelier_active_token_session');
    if (savedTokenSession && !browserRamCreds) {
      try {
        const parsed = JSON.parse(savedTokenSession);
        if (parsed.canvasApiToken) {
          await unlockCloudWithToken(
            parsed.canvasApiToken,
            parsed.canvasBaseUrl,
            parsed.googleEmail,
            parsed.displayName
          );
          return;
        }
      } catch (error) {
        console.warn('Saved browser session could not be restored:', error);
      }
    }

    if (browserRamCreds) {
      state.authenticated = true;
      state.credentials = {
        configured: true,
        canvasBaseUrl: browserRamCreds.canvasBaseUrl,
        maskedToken: maskTokenClient(browserRamCreds.canvasApiToken),
      };
    } else {
      state.authenticated = false;
    }

    await updateViewForAuthState();
  }

  async function unlockCloudWithToken(rawToken, rawUrl, googleEmail = '', displayName = '') {
    const { token, url } = extractTokenAndUrl(rawToken, rawUrl);
    if (!token || token.length < 10) {
      throw new Error('Please paste a valid Canvas access token.');
    }

    if (window.__ENCRYPTED_CANVAS_SNAPSHOT__) {
      try {
        unlockedSnapshotData = await decryptTokenKeyedSnapshot(
          token,
          window.__ENCRYPTED_CANVAS_SNAPSHOT__
        );
      } catch (error) {
        console.warn('Encrypted dashboard snapshot could not be decrypted:', error);
        unlockedSnapshotData = null;
      }
    }

    const resolvedName =
      displayName || unlockedSnapshotData?.studentName || 'Student';
    const resolvedEmail =
      googleEmail ||
      `${resolvedName.toLowerCase().replace(/\s+/g, '.')}@gmail.com`;

    browserRamCreds = {
      canvasBaseUrl: url,
      canvasApiToken: token,
      googleEmail: resolvedEmail,
      displayName: resolvedName,
    };
    setStoredItem('sessionStorage', 'atelier_active_token_session', JSON.stringify(browserRamCreds));

    await saveEncryptedGoogleVault({
      canvasBaseUrl: url,
      canvasApiToken: token,
      googleEmail: resolvedEmail,
      displayName: resolvedName,
    });
    await registerTokenLifecycle(token, url);

    state.cloudStaticMode = true;
    state.authenticated = true;
    state.user = {
      name: resolvedName,
      email: resolvedEmail,
    };
    state.credentials = {
      configured: true,
      canvasBaseUrl: url,
      maskedToken: maskTokenClient(token),
    };

    await updateViewForAuthState();
  }

  async function connectWithTokenPayload({
    rawToken,
    rawUrl,
    envFileContent,
    importWorkspaceEnv,
    googleEmail = '',
    displayName = '',
  }) {
    let tokenToUse = rawToken || '';
    let urlToUse = rawUrl || 'https://wcpss.instructure.com';
    if (envFileContent) {
      const parsed = parseEnvTextClient(envFileContent);
      if (parsed.CANVAS_API_TOKEN) tokenToUse = parsed.CANVAS_API_TOKEN;
      if (parsed.CANVAS_BASE_URL) urlToUse = parsed.CANVAS_BASE_URL;
    }

    if (state.cloudStaticMode) {
      await unlockCloudWithToken(tokenToUse, urlToUse, googleEmail, displayName);
      showToast('Workspace unlocked.');
      return;
    }

    const res = await apiFetch('/api/auth/connect-token', {
      method: 'POST',
      body: {
        canvasApiToken: rawToken,
        canvasBaseUrl: rawUrl,
        envFileContent,
        importWorkspaceEnv,
        persistMode: 'encrypted_disk',
      },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not connect token.');
    }

    const finalName = displayName || data.studentName || 'Student';
    const finalEmail =
      googleEmail ||
      data.user?.email ||
      `${finalName.toLowerCase().replace(/\s+/g, '.')}@gmail.com`;

    if (tokenToUse) {
      const cleanTok = extractTokenAndUrl(tokenToUse, urlToUse).token;
      await saveEncryptedGoogleVault({
        canvasBaseUrl: data.canvasBaseUrl || urlToUse,
        canvasApiToken: cleanTok,
        googleEmail: finalEmail,
        displayName: finalName,
      });
      await registerTokenLifecycle(cleanTok, data.canvasBaseUrl || urlToUse);
    }

    showToast(`Signed in as ${finalName}`);
    await checkSessionAndLoad();
  }

  async function updateViewForAuthState() {
    renderSavedGoogleBox();

    if (!state.authenticated || !state.credentials.configured) {
      els.authGateSection.classList.remove('hidden');
      els.dashboardMain.classList.add('hidden');
      els.sectionNavLinks.classList.add('hidden');
      els.openCmdPaletteBtn.classList.add('hidden');
      els.openBriefingsDrawerBtn.classList.add('hidden');
      els.refreshBtn.classList.add('hidden');
      els.startQuickFocusBtn.classList.add('hidden');
      els.userProfileBar.classList.add('hidden');
      triggerRevealAnimations();
      return;
    }

    closeTokenModal();
    els.authGateSection.classList.add('hidden');
    els.dashboardMain.classList.remove('hidden');
    els.sectionNavLinks.classList.remove('hidden');
    els.openCmdPaletteBtn.classList.remove('hidden');
    els.openBriefingsDrawerBtn.classList.remove('hidden');
    els.refreshBtn.classList.remove('hidden');
    updateFocusTimerDisplay();

    els.userProfileBar.classList.remove('hidden');
    els.userProfileBar.classList.add('flex');
    const savedMeta = readStoredJson(
      'slated_google_profile_meta',
      {},
      (value) => value && typeof value === 'object' && !Array.isArray(value)
    );
    const badgeLabel =
      savedMeta.googleEmail && savedMeta.googleEmail.includes('@')
        ? savedMeta.googleEmail
        : state.user?.name || state.user?.email || 'Student';
    els.userEmailBadge.textContent = badgeLabel;

    state.canvasBaseUrl = state.credentials.canvasBaseUrl || 'https://wcpss.instructure.com';
    renderTokenLifecycleUI();
    if (els.canvasInstanceLink) {
      els.canvasInstanceLink.href = safeHttpUrl(state.canvasBaseUrl) || '#';
      els.canvasInstanceLink.textContent = state.canvasBaseUrl.replace(/^https?:\/\//, '');
    }

    triggerRevealAnimations();
    await loadDashboardData(false);
  }

  // -------------------------------------------------------------------------
  // 7. Assignment Urgency, Completion & Combined Queue
  // -------------------------------------------------------------------------
  function isAssignmentDone(a) {
    if (!a) return false;
    const key = String(a.id);
    if (state.inClassRetakeIds && state.inClassRetakeIds.has(key)) return false;
    if (state.checkedIds.has(key)) return true;
    if (a.is_submitted === true) return true;
    const sub = a.submission || {};
    if (
      sub.workflow_state === 'submitted' ||
      sub.workflow_state === 'graded' ||
      sub.submitted_at ||
      sub.score != null ||
      sub.excused === true
    ) {
      return true;
    }
    if (isPastInClassAssessment(a)) {
      return true;
    }
    return false;
  }

  function toggleAssignmentDone(id, triggerEl = null) {
    const key = String(id);
    const cardEl = document.getElementById(`task-card-${key}`);

    if (state.checkedIds.has(key)) {
      state.checkedIds.delete(key);
      setStoredItem('localStorage', 'atelier_checked_ids', JSON.stringify(Array.from(state.checkedIds)));
      renderAll();
      showToast('Restored to active queue.');
    } else {
      let x = null;
      let y = null;
      if (triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      playSuccessChime();
      launchConfetti(x, y);

      if (cardEl) {
        cardEl.classList.add('task-completing');
      }

      state.checkedIds.add(key);
      setStoredItem('localStorage', 'atelier_checked_ids', JSON.stringify(Array.from(state.checkedIds)));

      showToast("Completed! Phew, that's done.", 'Undo', () => {
        state.checkedIds.delete(key);
        setStoredItem('localStorage', 'atelier_checked_ids', JSON.stringify(Array.from(state.checkedIds)));
        renderAll();
        showToast('Restored to active queue.');
      });

      setTimeout(() => {
        renderAll();
      }, 340);
    }
  }

  function getCombinedAssignments() {
    const { deadlineOverrides, virtualAssessments } = getAnnouncementContextEnrichments();

    const customMapped = state.customTasks.map((t) => ({
      id: t.id,
      course_id: t.course_id,
      name: t.name,
      due_at: t.due_at,
      points_possible: null,
      is_custom: true,
      is_submitted: false,
      description: 'Personal reminder',
      html_url: null,
    }));

    const combined = [...customMapped, ...virtualAssessments, ...state.assignments];
    return combined.map((a) => {
      const ctxInfo = evaluateAssignmentContext(a, deadlineOverrides);
      const nameLower = String(a.name || '').toLowerCase();
      let autoStudyDeck = ctxInfo.studyDeckLink || a.study_deck_link || null;
      if (!autoStudyDeck) {
        if (/logarithmic|derivative|quiz.*derivative/i.test(nameLower)) autoStudyDeck = 'calc_log';
        else if (/implicit/i.test(nameLower)) autoStudyDeck = 'calc_implicit';
        else if (/multiplier|krugman|aggregate/i.test(nameLower)) autoStudyDeck = 'macro_mult';
        else if (/columbian exchange/i.test(nameLower)) autoStudyDeck = 'world_pbl';
      }
      const course = getCourseById(a.course_id);
      const supplies = extractRequiredSupplies(a, course);
      const accelerators = getTopicAccelerators(a, course);
      const deliverableChecklist = getAssignmentDeliverableChecklist(a);
      const inClassAssessment = isInClassAssessment(a);
      const pastInClass = isPastInClassAssessment(a);

      const naaCutoff = parseAssignmentNaa(a);
      let kindBadge = 'Take-Home';
      if (inClassAssessment) {
        kindBadge = pastInClass ? 'In-Class (Concluded)' : 'In-Class Assessment';
      } else if (/classwork|\bcw\b|in-class|seminar|flame test|gizmos/i.test(nameLower)) {
        kindBadge = 'In-Class Activity';
      } else if (/homework|\bhw\b|problem set|worksheet/i.test(nameLower)) {
        kindBadge = 'Homework';
      } else if (/project|brochure|poster/i.test(nameLower)) {
        kindBadge = 'Project';
      }

      return {
        ...a,
        effective_due_at: ctxInfo.effectiveDueAt,
        is_active_context: ctxInfo.isActiveContext,
        is_archived_context: ctxInfo.isArchivedContext,
        context_badge: ctxInfo.contextBadge,
        context_note: ctxInfo.contextNote,
        effort_label: estimateAssignmentEffort(a),
        study_deck_link: autoStudyDeck,
        supplies,
        accelerators,
        deliverable_checklist: deliverableChecklist,
        is_in_class_assessment: inClassAssessment,
        is_past_in_class: pastInClass,
        assignment_kind_badge: kindBadge,
        naa_cutoff_at: naaCutoff,
      };
    });
  }

  function getUrgencyInfo(assignment) {
    const dueAtIso = assignment.effective_due_at || assignment.due_at;
    const done = isAssignmentDone(assignment);
    const hasScore = assignment.score != null && assignment.points_possible;
    const scoreText = hasScore
      ? `Graded • ${Math.round(assignment.score * 10) / 10}/${assignment.points_possible}`
      : 'Done';

    const now = Date.now();
    const dueMs = dueAtIso ? new Date(dueAtIso).getTime() : null;

    if (done) {
      const isAutoInClass = isPastInClassAssessment(assignment) && !state.checkedIds.has(String(assignment.id));
      const scoreLabel = hasScore
        ? `Graded • ${Math.round(assignment.score * 10) / 10}/${assignment.points_possible}`
        : isAutoInClass
        ? 'Taken in class'
        : 'Done';

      return {
        level: 'green',
        label: scoreLabel,
        chipClass: 'status-chip status-chip-green',
        dotClass: 'status-dot status-dot-green',
        stripClass: 'urgency-strip-green',
        sortWeight: dueMs && dueMs >= now ? dueMs + 1e11 : 2e13 - (dueMs || 0),
      };
    }

    if (state.inClassRetakeIds && state.inClassRetakeIds.has(String(assignment.id))) {
      return {
        level: 'amber',
        label: 'Absent / Need Retake',
        chipClass: 'status-chip status-chip-amber',
        dotClass: 'status-dot status-dot-amber',
        stripClass: 'urgency-strip-amber',
        sortWeight: -1e10,
      };
    }

    if (isInClassAssessment(assignment) && !isPastInClassAssessment(assignment)) {
      const bell = getCourseBellInfo(assignment.course_id);
      return {
        level: 'red',
        label: `In-Class ${bell.period} (${bell.startText})`,
        chipClass: 'status-chip status-chip-red',
        dotClass: 'status-dot status-dot-red',
        stripClass: 'urgency-strip-red',
        sortWeight: (dueMs || now) - 1e8,
      };
    }

    if (assignment.is_archived_context) {
      return {
        level: 'green',
        label: assignment.context_badge || 'Archived Unit',
        chipClass: 'status-chip status-chip-green',
        dotClass: 'status-dot status-dot-green',
        stripClass: 'urgency-strip-green',
        sortWeight: 3e13 - (dueMs || 0),
      };
    }

    if (!dueAtIso || Number.isNaN(dueMs)) {
      return {
        level: 'yellow',
        label: 'Active Unit • Open Date',
        chipClass: 'status-chip status-chip-yellow',
        dotClass: 'status-dot status-dot-yellow',
        stripClass: 'urgency-strip-yellow',
        sortWeight: now + 4 * 86400 * 1000,
      };
    }

    const diffMs = dueMs - now;
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = diffHours / 24;

    if (diffHours < 0) {
      const daysAgo = Math.abs(Math.round(diffDays));
      const hoursAgo = Math.abs(Math.round(diffHours));

      // Overdue older than 14 days is a past unit/term, NOT active urgent panic
      if (daysAgo > 14) {
        return {
          level: 'gray',
          label: `Past Unit (${daysAgo}d ago)`,
          chipClass: 'status-chip status-chip-gray',
          dotClass: 'status-dot status-dot-gray',
          stripClass: 'urgency-strip-gray',
          sortWeight: 2e13 - (dueMs || 0),
        };
      }

      if (assignment.no_online_submission || assignment.points_possible === 0 || isInClassOrPaperWork(assignment)) {
        return {
          level: 'green',
          label: daysAgo <= 1 ? 'Done in class (Yesterday)' : `Done in class (${daysAgo}d ago)`,
          chipClass: 'status-chip status-chip-green',
          dotClass: 'status-dot status-dot-green',
          stripClass: 'urgency-strip-green',
          sortWeight: now + Math.abs(diffMs) + 5e9,
        };
      }
      return {
        level: 'red',
        label: hoursAgo < 24 ? `Due ${hoursAgo}h ago` : `Due ${daysAgo}d ago`,
        chipClass: 'status-chip status-chip-red',
        dotClass: 'status-dot status-dot-red',
        stripClass: 'urgency-strip-red',
        sortWeight: now + Math.abs(diffMs),
      };
    }

    if (diffHours <= 48) {
      return {
        level: 'red',
        label: diffHours < 1 ? 'Due < 1h' : `Due in ${Math.round(diffHours)}h`,
        chipClass: 'status-chip status-chip-red',
        dotClass: 'status-dot status-dot-red',
        stripClass: 'urgency-strip-red',
        sortWeight: dueMs,
      };
    }

    if (diffDays <= 5) {
      return {
        level: 'yellow',
        label: `Due in ${Math.ceil(diffDays)}d`,
        chipClass: 'status-chip status-chip-yellow',
        dotClass: 'status-dot status-dot-yellow',
        stripClass: 'urgency-strip-yellow',
        sortWeight: dueMs,
      };
    }

    return {
      level: 'green',
      label: `Due in ${Math.ceil(diffDays)}d`,
      chipClass: 'status-chip status-chip-green',
      dotClass: 'status-dot status-dot-green',
      stripClass: 'urgency-strip-green',
      sortWeight: dueMs,
    };
  }

  function formatDateTime(iso) {
    if (!iso) return 'Active Unit Work';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Active Unit Work';
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function getCourseById(courseId) {
    return state.courses.find((c) => String(c.id) === String(courseId)) || null;
  }

  function matchesSearchAndCourse(itemCourseId, searchableText) {
    if (
      state.selectedCourseId !== 'all' &&
      String(itemCourseId) !== String(state.selectedCourseId)
    ) {
      return false;
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!String(searchableText || '').toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 8. Saved Briefings Vault Logic
  // -------------------------------------------------------------------------
  function autoInitializeSavedBriefings() {
    if (state.savedBriefingsInitialized || state.announcements.length === 0) return;
    for (const ann of state.announcements) {
      const text = `${ann.title || ''} ${ann.clean_text || ''}`;
      if (
        /let's take a quiz|columbian exchange menu due date|q1 grades updated|missing assignments|logarithmic|implicit/i.test(
          text
        )
      ) {
        state.savedBriefingIds.add(String(ann.id));
      }
      if (state.savedBriefingIds.size >= 6) break;
    }
    state.savedBriefingsInitialized = true;
    setStoredItem(
      'localStorage',
      'atelier_saved_briefings',
      JSON.stringify(Array.from(state.savedBriefingIds))
    );
  }

  function toggleSaveBriefing(annId) {
    const key = String(annId);
    if (state.savedBriefingIds.has(key)) {
      state.savedBriefingIds.delete(key);
      showToast('Removed from Saved Briefings.');
    } else {
      state.savedBriefingIds.add(key);
      showToast('Pinned to Saved Briefings.');
    }
    setStoredItem(
      'localStorage',
      'atelier_saved_briefings',
      JSON.stringify(Array.from(state.savedBriefingIds))
    );
    renderSavedBriefingsDrawer();
    renderAll();
  }

  function renderSavedBriefingsDrawer() {
    if (els.savedBriefingsCountBadge) {
      els.savedBriefingsCountBadge.textContent = String(state.savedBriefingIds.size);
    }
    if (!els.savedBriefingsList) return;

    const savedAnns = state.announcements.filter((a) =>
      state.savedBriefingIds.has(String(a.id))
    );

    if (savedAnns.length === 0) {
      els.savedBriefingsList.innerHTML = `
        <div class="p-6 tone-surface space-y-2">
          <p class="font-bold">No saved briefings yet.</p>
          <p class="secondary-copy text-sm">
            Click <strong>Save Briefing</strong> on any teacher announcement to keep quiz outlines, grade policies, and study keys pinned here.
          </p>
        </div>`;
      return;
    }

    els.savedBriefingsList.innerHTML = savedAnns
      .map((rawAnn) => {
        const ann = ensureAnnouncementSummarized(rawAnn);
        const courseId = String(ann.context_code || '').replace(/^course_/, '');
        const course = getCourseById(courseId);
        const meta = course ? parseCourseMeta(course) : { period: '', title: 'Class' };

        const bulletsHtml =
          Array.isArray(ann.bullets) && ann.bullets.length > 0
            ? `<ul class="list-disc list-inside space-y-1 text-xs secondary-copy pt-1">
                ${ann.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}
              </ul>`
            : `<p class="secondary-copy text-xs">${escapeHtml(ann.tldr)}</p>`;

        const filesHtml =
          Array.isArray(ann.attachments) && ann.attachments.length > 0
            ? `<div class="pt-2 flex flex-wrap gap-2">
                ${ann.attachments
                  .map(
                    (f) =>
                      `<a href="${escapeHtml(
                        safeHttpUrl(f.url) || '#'
                      )}" target="_blank" rel="noopener noreferrer" class="context-tag hover:underline" style="color: var(--accent);">${escapeHtml(
                        f.display_name
                      )}</a>`
                  )
                  .join('')}
              </div>`
            : '';

        return `
          <article class="p-5 tone-surface space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-bold" style="color: var(--ink-secondary);">
                ${escapeHtml(meta.title)} • ${escapeHtml(ann.author_name)}
              </span>
              <span class="context-tag context-tag-accent">${escapeHtml(ann.category)}</span>
            </div>
            <h3 class="text-base font-bold leading-snug">
              <a href="${escapeHtml(
                safeHttpUrl(ann.html_url || state.canvasBaseUrl) || '#'
              )}" target="_blank" rel="noopener noreferrer" class="hover:underline">
                ${escapeHtml(ann.title)}
              </a>
            </h3>
            ${bulletsHtml}
            ${filesHtml}
            <div class="pt-3 flex items-center justify-between text-xs" style="border-top: 1px solid var(--surface-2);">
              <span class="tabular secondary-copy">${escapeHtml(formatDateTime(ann.posted_at))}</span>
              <div class="flex items-center gap-3 font-bold">
                <button type="button" data-unsave-briefing="${escapeHtml(
                  ann.id
                )}" class="underline" style="color: var(--ink-secondary);">Remove</button>
                <a href="${escapeHtml(
                  safeHttpUrl(ann.html_url || state.canvasBaseUrl) || '#'
                )}" target="_blank" rel="noopener noreferrer" class="underline" style="color: var(--accent);">Open in Canvas</a>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    els.savedBriefingsList.querySelectorAll('[data-unsave-briefing]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleSaveBriefing(btn.getAttribute('data-unsave-briefing'));
      });
    });
  }

  // -------------------------------------------------------------------------
  // 9. Class Inspector, Target Grade Calculator & What-If Grade Lab
  // -------------------------------------------------------------------------
  function openCourseInspector(courseId, initialTab = 'overview') {
    state.inspectorCourseId = String(courseId);
    state.inspectorTab = initialTab;
    if (!els.courseInspectorBackdrop) return;
    els.courseInspectorBackdrop.classList.remove('hidden');
    renderCourseInspector();
  }

  function closeCourseInspector() {
    if (!els.courseInspectorBackdrop) return;
    els.courseInspectorBackdrop.classList.add('hidden');
    state.inspectorCourseId = null;
  }

  function renderCourseInspector() {
    if (!state.inspectorCourseId || !els.courseInspectorBody) return;
    const course = getCourseById(state.inspectorCourseId);
    if (!course) return;

    const cid = String(course.id);
    const meta = parseCourseMeta(course);
    const ctx = state.courseContexts[cid] || {
      activeUnitLabel: 'Active Unit',
      completedUnitNums: [],
      modules: [],
      groups: [],
    };
    const avgObj = computeCourseAverageObject(cid, true);

    els.inspectorCoursePeriod.textContent = `${meta.period} • ${meta.teacher || 'Instructor'}`;
    els.inspectorCourseTitle.textContent = meta.title;
    els.inspectorCourseMeta.textContent = `${ctx.activeUnitLabel}${
      avgObj ? ` • Score: ${avgObj.percent}% (${avgObj.earned}/${avgObj.possible} pts)` : ''
    }`;

    document.querySelectorAll('.inspector-tab-btn').forEach((btn) => {
      btn.classList.toggle(
        'studio-btn-primary',
        btn.getAttribute('data-inspector-tab') === state.inspectorTab
      );
    });

    if (state.inspectorTab === 'overview') {
      const completedLabel =
        ctx.completedUnitNums && ctx.completedUnitNums.length > 0
          ? `Units ${ctx.completedUnitNums.join(', ')}`
          : '—';

      const modulesHtml =
        Array.isArray(ctx.modules) && ctx.modules.length > 0
          ? ctx.modules
              .slice()
              .reverse()
              .map(
                (m) => `
                <div class="p-4 tone-surface space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="text-sm font-bold">${escapeHtml(m.name)}</h4>
                    <span class="context-tag tabular">${escapeHtml(
                      String(m.items_count || (m.items && m.items.length) || 0)
                    )} items</span>
                  </div>
                  ${
                    Array.isArray(m.items) && m.items.length > 0
                      ? `<ul class="space-y-1 text-xs secondary-copy pt-1">
                          ${m.items
                            .slice(0, 8)
                            .map(
                              (it) =>
                                `<li class="flex items-center justify-between gap-2">
                                  <span class="truncate">• ${escapeHtml(it.title)}</span>
                                  ${
                                    it.html_url
                                      ? `<a href="${escapeHtml(
                                          safeHttpUrl(it.html_url) || '#'
                                        )}" target="_blank" rel="noopener noreferrer" class="underline shrink-0" style="color: var(--accent);">Open</a>`
                                      : ''
                                  }
                                </li>`
                            )
                            .join('')}
                        </ul>`
                      : ''
                  }
                </div>`
              )
              .join('')
          : `<div class="p-4 tone-surface text-xs secondary-copy">
              This class doesn’t use Canvas Modules.
            </div>`;

      const syllabusText =
        course.syllabus_summary || stripHtml(course.syllabus_body || '').slice(0, 700);

      els.courseInspectorBody.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="p-4 tone-surface">
            <p class="text-xs secondary-copy">Current Active Unit</p>
            <p class="mt-1 text-sm font-bold">${escapeHtml(ctx.activeUnitLabel)}</p>
          </div>
          <div class="p-4 tone-surface">
            <p class="text-xs secondary-copy">Completed Units</p>
            <p class="mt-1 text-sm font-bold">${escapeHtml(completedLabel)}</p>
          </div>
        </div>

        ${
          syllabusText
            ? `<div class="p-4 tone-surface space-y-1.5">
                <p class="text-xs font-bold" style="color: var(--ink-secondary);">Course Syllabus Summary</p>
                <p class="text-xs secondary-copy leading-relaxed">${escapeHtml(syllabusText)}</p>
              </div>`
            : ''
        }

        <div class="space-y-2.5">
          <h3 class="text-sm font-bold">Course Modules (Newest First)</h3>
          ${modulesHtml}
        </div>
      `;
      return;
    }

    if (state.inspectorTab === 'gradelab') {
      const courseAssigns = state.assignments
        .filter(
          (a) =>
            String(a.course_id) === cid &&
            a.points_possible != null &&
            Number(a.points_possible) > 0
        )
        .sort((a, b) => {
          const da = a.due_at ? new Date(a.due_at).getTime() : 0;
          const db = b.due_at ? new Date(b.due_at).getTime() : 0;
          return db - da;
        });

      const actualAvg = computeCourseAverageObject(cid, false);
      const projectedAvg = computeCourseAverageObject(cid, true);
      const customTests = state.whatIfCustomTests[cid] || [];
      const courseGroups = Array.isArray(ctx.groups) ? ctx.groups : [];

      const tCfg = state.targetGradeInputs[cid] || {
        targetPercent: 90,
        nextTestPoints: 100,
        groupId: (actualAvg?.categories?.[0]?.id) || '',
      };

      let targetInsightHtml = '';
      if (actualAvg) {
        if (actualAvg.isWeighted && actualAvg.categories.length > 0) {
          const chosenGroup = actualAvg.categories.find((g) => String(g.id) === String(tCfg.groupId)) || actualAvg.categories[0];
          const Wg = chosenGroup.weight;
          const Wactive = actualAvg.activeWeight;
          const otherContribution = actualAvg.categories
            .filter((g) => g.id !== chosenGroup.id)
            .reduce((acc, g) => acc + (g.percent * g.weight), 0);

          if (Wg > 0) {
            const neededGroupPct = ((tCfg.targetPercent * Wactive) - otherContribution) / Wg;
            const targetTotalPossible = chosenGroup.possible + tCfg.nextTestPoints;
            const neededTotalEarned = (neededGroupPct / 100) * targetTotalPossible;
            const neededOnTest = Math.round((neededTotalEarned - chosenGroup.earned) * 10) / 10;
            const neededPct = Math.round((neededOnTest / tCfg.nextTestPoints) * 1000) / 10;

            if (neededOnTest <= 0) {
              targetInsightHtml = `
                <p class="text-xs font-semibold pt-1" style="color: var(--calm);">
                  Target secured! Even with 0/${tCfg.nextTestPoints} in <strong>${escapeHtml(chosenGroup.name)}</strong>, your grade stays at ${Math.round(((otherContribution + (chosenGroup.earned / targetTotalPossible * Wg * 100)) / Wactive) * 10) / 10}%.
                </p>`;
            } else if (neededPct > 100) {
              targetInsightHtml = `
                <p class="text-xs font-semibold pt-1" style="color: var(--urgent);">
                  To reach <strong>${tCfg.targetPercent}%</strong>, you need <span class="tabular font-bold">${neededOnTest} / ${tCfg.nextTestPoints} (${neededPct}%)</span> in <strong>${escapeHtml(chosenGroup.name)}</strong> (extra credit required due to ${Wg}% weight).
                </p>`;
            } else {
              targetInsightHtml = `
                <p class="text-xs font-semibold pt-1" style="color: var(--ink);">
                  To reach <strong>${tCfg.targetPercent}%</strong> after a <strong>${tCfg.nextTestPoints}-pt</strong> test in <strong>${escapeHtml(chosenGroup.name)}</strong> (${Wg}% weight), you need at least
                  <span class="tabular font-bold" style="color: var(--accent);">${neededOnTest} / ${tCfg.nextTestPoints} (${neededPct}%)</span>.
                </p>`;
            }
          }
        } else {
          const neededTotalEarned =
            (tCfg.targetPercent / 100) * (actualAvg.possible + tCfg.nextTestPoints);
          const neededOnTest = Math.round((neededTotalEarned - actualAvg.earned) * 10) / 10;
          const neededPct = Math.round((neededOnTest / tCfg.nextTestPoints) * 1000) / 10;
          targetInsightHtml = `
            <p class="text-xs font-semibold pt-1" style="color: var(--ink);">
              To reach <strong>${tCfg.targetPercent}%</strong> after a <strong>${tCfg.nextTestPoints}-pt</strong> test, you need at least
              <span class="tabular font-bold" style="color: var(--accent);">${Math.max(0, neededOnTest)} / ${
            tCfg.nextTestPoints
          } (${Math.max(0, neededPct)}%)</span>.
            </p>`;
        }
      } else {
        targetInsightHtml = `<p class="text-xs secondary-copy pt-1">Add a hypothetical score below to start calculating grade targets.</p>`;
      }

      const categoriesHtml = actualAvg && actualAvg.isWeighted && actualAvg.categories.length > 0
        ? `<div class="p-4 tone-surface space-y-2.5">
            <div class="flex items-center justify-between">
              <p class="text-xs font-bold">Graded Category Breakdown</p>
              <span class="context-tag context-tag-accent tabular">Weighted System (${actualAvg.activeWeight}%)</span>
            </div>
            <div class="space-y-1.5 pt-1">
              ${actualAvg.categories.map((c) => `
                <div class="p-2.5 tone-surface-2 flex items-center justify-between text-xs">
                  <div>
                    <span class="font-bold">${escapeHtml(c.name)}</span>
                    <span class="secondary-copy ml-1 font-semibold">(${c.weight}% weight)</span>
                    ${c.droppedCount > 0 ? `<span class="grade-drop-tag ml-1.5">Drop lowest ${c.droppedCount}</span>` : ''}
                  </div>
                  <span class="tabular font-bold">${c.percent}% (${c.earned}/${c.possible} pts)</span>
                </div>
              `).join('')}
            </div>
          </div>`
        : '';

      els.courseInspectorBody.innerHTML = `
        <div class="grid grid-cols-2 gap-3">
          <div class="p-4 tone-surface">
            <p class="text-xs secondary-copy">Current Graded Average</p>
            <p class="mt-1 text-2xl font-bold tabular">${
              actualAvg ? `${actualAvg.percent}% (${actualAvg.letterGrade})` : 'No graded items'
            }</p>
            <p class="text-xs secondary-copy tabular">${
              actualAvg ? `${actualAvg.earned} / ${actualAvg.possible} pts${actualAvg.isWeighted ? ' • Weighted' : ''}` : ''
            }</p>
          </div>
          <div class="p-4 tone-surface-2" style="border-left: 4px solid var(--accent);">
            <p class="text-xs secondary-copy">What-If Projected Average</p>
            <p class="mt-1 text-2xl font-bold tabular" style="color: var(--accent);">${
              projectedAvg ? `${projectedAvg.percent}% (${projectedAvg.letterGrade})` : 'Enter scores below'
            }</p>
            <p class="text-xs secondary-copy tabular">${
              projectedAvg ? `${projectedAvg.earned} / ${projectedAvg.possible} pts${projectedAvg.isWeighted ? ' • Projected' : ''}` : ''
            }</p>
          </div>
        </div>

        ${categoriesHtml}

        <!-- What do I need on the next test? -->
        <div class="p-4 tone-surface space-y-2">
          <p class="text-xs font-bold">What do I need on the next test?</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label class="block text-[11px] secondary-copy mb-1">Target Grade (%)</label>
              <input id="targetGradePctInput" type="number" step="0.5" value="${tCfg.targetPercent}" class="studio-input text-xs py-1.5 tabular" />
            </div>
            <div>
              <label class="block text-[11px] secondary-copy mb-1">Test Points</label>
              <input id="targetTestPtsInput" type="number" step="5" value="${tCfg.nextTestPoints}" class="studio-input text-xs py-1.5 tabular" />
            </div>
            ${actualAvg && actualAvg.isWeighted && actualAvg.categories.length > 0 ? `
              <div>
                <label class="block text-[11px] secondary-copy mb-1">Category</label>
                <select id="targetCategorySelect" class="studio-select text-xs py-1.5 w-full">
                  ${actualAvg.categories.map((c) => `<option value="${escapeHtml(c.id)}" ${String(c.id) === String(tCfg.groupId) ? 'selected' : ''}>${escapeHtml(c.name)} (${c.weight}%)</option>`).join('')}
                </select>
              </div>` : ''}
          </div>
          ${targetInsightHtml}
        </div>

        <form id="whatIfAddTestForm" class="p-4 tone-surface space-y-2.5">
          <p class="text-xs font-bold">Add a hypothetical score</p>
          <div class="grid grid-cols-12 gap-2">
            <input id="whatIfTestName" type="text" required placeholder="e.g. Unit 4 Test" class="col-span-12 sm:col-span-5 studio-input text-xs py-1.5" />
            <input id="whatIfTestScore" type="number" step="0.5" required placeholder="Score (e.g. 94)" class="col-span-6 sm:col-span-2 studio-input text-xs py-1.5 tabular" />
            <input id="whatIfTestOutOf" type="number" step="0.5" required value="100" placeholder="Out of" class="col-span-6 sm:col-span-2 studio-input text-xs py-1.5 tabular" />
            ${courseGroups.length > 0 ? `
              <select id="whatIfTestGroup" class="col-span-12 sm:col-span-3 studio-select text-xs py-1.5 w-full">
                <option value="">Default Category</option>
                ${courseGroups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}${g.group_weight ? ` (${g.group_weight}%)` : ''}</option>`).join('')}
              </select>` : ''}
          </div>
          <div class="flex items-center justify-between pt-1">
            <button type="button" id="resetWhatIfBtn" class="text-xs underline secondary-copy">Reset All What-If Scores</button>
            <button type="submit" class="studio-btn studio-btn-primary text-xs py-1.5 px-3">Add Hypothetical Score</button>
          </div>
        </form>

        ${
          customTests.length > 0
            ? `<div class="space-y-1.5">
                <p class="text-xs font-bold">Hypothetical scores</p>
                ${customTests
                  .map(
                    (t) => `
                  <div class="p-3 tone-surface-2 flex items-center justify-between text-xs">
                    <div>
                      <span class="font-semibold">${escapeHtml(t.name)}</span>
                      ${t.groupId ? `<span class="context-tag ml-1.5">${escapeHtml(courseGroups.find(g => String(g.id) === String(t.groupId))?.name || 'Category')}</span>` : ''}
                    </div>
                    <div class="flex items-center gap-3 tabular">
                      <span class="font-bold" style="color: var(--accent);">${t.score} / ${t.outOf} pts</span>
                      <button type="button" data-remove-whatif-test="${escapeHtml(
                        t.id
                      )}" class="underline" style="color: var(--urgent);">Remove</button>
                    </div>
                  </div>`
                  )
                  .join('')}
              </div>`
            : ''
        }

        <div class="space-y-2">
          <p class="text-xs font-bold">Assignments — edit any score to see the effect</p>
          ${
            courseAssigns.length === 0
              ? `<div class="p-4 tone-surface text-xs secondary-copy">No graded assignments in Canvas yet.</div>`
              : courseAssigns
                  .map((a) => {
                    const key = String(a.id);
                    const hasWhatIf = state.whatIfScores[key] != null;
                    const displayVal = hasWhatIf
                      ? state.whatIfScores[key]
                      : a.score != null
                      ? a.score
                      : '';
                    const commentsHtml =
                      Array.isArray(a.submission_comments) && a.submission_comments.length > 0
                        ? `<p class="text-[11px] secondary-copy mt-1">"${escapeHtml(
                            a.submission_comments[0].comment
                          )}"</p>`
                        : '';
                    return `
                      <div class="p-3.5 tone-surface flex items-center justify-between gap-3">
                        <div class="min-w-0">
                          <p class="text-xs font-bold truncate">${escapeHtml(a.name)}</p>
                          <p class="text-[11px] secondary-copy tabular">
                            ${escapeHtml(a.group_name || 'Assignment')} • ${
                      a.score != null ? `Actual: ${a.score}/${a.points_possible}` : 'Ungraded'
                    }
                          </p>
                          ${commentsHtml}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0 tabular text-xs">
                          <input
                            type="number"
                            step="0.5"
                            data-whatif-input="${escapeHtml(a.id)}"
                            value="${escapeHtml(String(displayVal))}"
                            placeholder="—"
                            class="w-16 studio-input text-xs py-1 px-2 text-right tabular"
                          />
                          <span class="secondary-copy">/ ${a.points_possible}</span>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      `;

      const targetPctInp = document.getElementById('targetGradePctInput');
      const targetPtsInp = document.getElementById('targetTestPtsInput');
      const targetCatSel = document.getElementById('targetCategorySelect');

      const onTargetChange = () => {
        state.targetGradeInputs[cid] = {
          targetPercent: Number(targetPctInp?.value) || 90,
          nextTestPoints: Math.max(1, Number(targetPtsInp?.value) || 100),
          groupId: targetCatSel ? targetCatSel.value : '',
        };
        renderCourseInspector();
      };
      if (targetPctInp) targetPctInp.addEventListener('change', onTargetChange);
      if (targetPtsInp) targetPtsInp.addEventListener('change', onTargetChange);
      if (targetCatSel) targetCatSel.addEventListener('change', onTargetChange);

      const addForm = document.getElementById('whatIfAddTestForm');
      if (addForm) {
        addForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const name = document.getElementById('whatIfTestName').value.trim();
          const score = Number(document.getElementById('whatIfTestScore').value);
          const outOf = Number(document.getElementById('whatIfTestOutOf').value);
          const grpSel = document.getElementById('whatIfTestGroup');
          const groupId = grpSel ? grpSel.value : '';
          if (!name || Number.isNaN(score) || Number.isNaN(outOf) || outOf <= 0) return;
          if (!state.whatIfCustomTests[cid]) state.whatIfCustomTests[cid] = [];
          state.whatIfCustomTests[cid].push({
            id: `wt_${Date.now()}`,
            name,
            score,
            outOf,
            groupId,
          });
          renderCourseInspector();
          renderCourseCards();
          renderAll();
          showToast(`Added hypothetical score: ${score}/${outOf} for ${name}`);
        });
      }

      const resetBtn = document.getElementById('resetWhatIfBtn');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          for (const a of courseAssigns) {
            delete state.whatIfScores[String(a.id)];
          }
          delete state.whatIfCustomTests[cid];
          renderCourseInspector();
          renderCourseCards();
        });
      }

      els.courseInspectorBody.querySelectorAll('[data-remove-whatif-test]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tid = btn.getAttribute('data-remove-whatif-test');
          state.whatIfCustomTests[cid] = (state.whatIfCustomTests[cid] || []).filter(
            (t) => String(t.id) !== String(tid)
          );
          renderCourseCards();
        });
        inp.addEventListener('change', () => renderCourseInspector());
      });

      els.courseInspectorBody.querySelectorAll('[data-whatif-input]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const aid = inp.getAttribute('data-whatif-input');
          const raw = inp.value.trim();
          if (raw === '') {
            delete state.whatIfScores[aid];
          } else {
            const num = Number(raw);
            if (!Number.isNaN(num)) {
              state.whatIfScores[aid] = num;
            }
          }
          renderCourseInspector();
          renderCourseCards();
        });
      });
      return;
    }

    if (state.inspectorTab === 'files') {
      const courseAnns = state.announcements
        .filter((a) => String(a.context_code || '').replace(/^course_/, '') === cid)
        .map(ensureAnnouncementSummarized);

      if (courseAnns.length === 0) {
        els.courseInspectorBody.innerHTML = `
          <div class="p-5 tone-surface text-xs secondary-copy">
            No announcements posted for this class yet.
          </div>`;
        return;
      }

      els.courseInspectorBody.innerHTML = courseAnns
        .map((ann) => {
          const filesHtml =
            Array.isArray(ann.attachments) && ann.attachments.length > 0
              ? `<div class="pt-2 flex flex-wrap gap-2">
                  ${ann.attachments
                    .map(
                      (f) =>
                        `<a href="${escapeHtml(
                          safeHttpUrl(f.url) || '#'
                        )}" target="_blank" rel="noopener noreferrer" class="context-tag hover:underline" style="color: var(--accent);">${escapeHtml(
                          f.display_name
                        )}</a>`
                    )
                    .join('')}
                </div>`
              : '';

          return `
            <article class="p-4 tone-surface space-y-2">
              <div class="flex items-center justify-between text-xs">
                <span class="font-bold secondary-copy">${escapeHtml(ann.author_name)}</span>
                <span class="context-tag context-tag-accent">${escapeHtml(ann.category)}</span>
              </div>
              <h4 class="text-sm font-bold">${escapeHtml(ann.title)}</h4>
              <p class="text-xs secondary-copy">${escapeHtml(ann.tldr)}</p>
              ${filesHtml}
              <div class="pt-2 flex items-center justify-between text-xs" style="border-top: 1px solid var(--surface-2);">
                <span class="tabular secondary-copy">${escapeHtml(formatDateTime(ann.posted_at))}</span>
                <a href="${escapeHtml(
                  safeHttpUrl(ann.html_url || state.canvasBaseUrl) || '#'
                )}" target="_blank" rel="noopener noreferrer" class="underline font-bold" style="color: var(--accent);">Open in Canvas</a>
              </div>
            </article>
          `;
        })
        .join('');
    }
  }

  // -------------------------------------------------------------------------
  // 10. Render Main Dashboard Sections & Today's Gameplan Strip
  // -------------------------------------------------------------------------
  function getLetterGrade(pct) {
    if (pct == null || Number.isNaN(pct)) return '—';
    if (pct >= 93) return 'A';
    if (pct >= 90) return 'A-';
    if (pct >= 87) return 'B+';
    if (pct >= 83) return 'B';
    if (pct >= 80) return 'B-';
    if (pct >= 77) return 'C+';
    if (pct >= 73) return 'C';
    if (pct >= 70) return 'C-';
    if (pct >= 60) return 'D';
    return 'F';
  }

  function computeCourseAverageObject(courseId, includeWhatIf = false) {
    const cid = String(courseId);
    const courseAssigns = state.assignments.filter(
      (a) =>
        String(a.course_id) === cid &&
        a.points_possible != null &&
        Number(a.points_possible) > 0 &&
        !a.excused
    );

    const ctx = state.courseContexts[cid] || {};
    const rawGroups = Array.isArray(ctx.groups) ? ctx.groups : [];

    // Map each assignment group
    const groupMap = new Map();
    let hasWeightedGroups = false;

    for (const g of rawGroups) {
      if (g && g.id != null) {
        const weight = Number(g.group_weight) || 0;
        groupMap.set(String(g.id), {
          id: String(g.id),
          name: g.name || 'Category',
          weight,
          rules: g.rules || {},
          items: [],
        });
        if (weight > 0) hasWeightedGroups = true;
      }
    }

    const unassignedItems = [];

    // Bucket assignments
    for (const item of courseAssigns) {
      const aid = String(item.id);
      const whatIfVal = includeWhatIf ? state.whatIfScores[aid] : null;
      const scoreToUse = whatIfVal != null ? Number(whatIfVal) : (item.score != null ? Number(item.score) : null);
      if (scoreToUse == null || Number.isNaN(scoreToUse)) continue;

      const scoredObj = {
        id: aid,
        name: item.name,
        earned: scoreToUse,
        possible: Number(item.points_possible),
        percent: (scoreToUse / Number(item.points_possible)) * 100,
      };

      const gid = item.assignment_group_id ? String(item.assignment_group_id) : null;
      if (gid && groupMap.has(gid)) {
        groupMap.get(gid).items.push(scoredObj);
      } else {
        unassignedItems.push(scoredObj);
      }
    }

    // Add hypothetical custom tests
    if (includeWhatIf && Array.isArray(state.whatIfCustomTests[cid])) {
      for (const t of state.whatIfCustomTests[cid]) {
        const customObj = {
          id: t.id,
          name: t.name,
          earned: Number(t.score),
          possible: Number(t.outOf),
          percent: (Number(t.score) / Number(t.outOf)) * 100,
        };
        const tGid = t.groupId ? String(t.groupId) : null;
        if (tGid && groupMap.has(tGid)) {
          groupMap.get(tGid).items.push(customObj);
        } else if (groupMap.size > 0) {
          let highestGroup = null;
          for (const g of groupMap.values()) {
            if (!highestGroup || g.weight > highestGroup.weight) highestGroup = g;
          }
          if (highestGroup) highestGroup.items.push(customObj);
          else unassignedItems.push(customObj);
        } else {
          unassignedItems.push(customObj);
        }
      }
    }

    // Weighted categories calculation
    if (hasWeightedGroups) {
      const categoryBreakdown = [];
      let weightedPctSum = 0;
      let activeWeightSum = 0;
      let totalEarned = 0;
      let totalPossible = 0;

      for (const g of groupMap.values()) {
        if (g.items.length === 0) continue;

        let activeItems = [...g.items];
        let droppedItems = [];
        const dropLowestCount = (g.rules && Number(g.rules.drop_lowest)) || 0;
        if (dropLowestCount > 0 && activeItems.length > dropLowestCount) {
          activeItems.sort((a, b) => a.percent - b.percent);
          droppedItems = activeItems.slice(0, dropLowestCount);
          activeItems = activeItems.slice(dropLowestCount);
        }

        const groupEarned = activeItems.reduce((acc, it) => acc + it.earned, 0);
        const groupPossible = activeItems.reduce((acc, it) => acc + it.possible, 0);
        if (groupPossible <= 0) continue;

        const groupPct = (groupEarned / groupPossible) * 100;
        const weightToUse = g.weight > 0 ? g.weight : 0;

        if (weightToUse > 0) {
          weightedPctSum += groupPct * weightToUse;
          activeWeightSum += weightToUse;
        }

        totalEarned += groupEarned;
        totalPossible += groupPossible;

        categoryBreakdown.push({
          id: g.id,
          name: g.name,
          weight: g.weight,
          earned: Math.round(groupEarned * 10) / 10,
          possible: Math.round(groupPossible * 10) / 10,
          percent: Math.round(groupPct * 10) / 10,
          itemsCount: activeItems.length,
          droppedCount: droppedItems.length,
        });
      }

      if (activeWeightSum > 0) {
        const finalPct = Math.round((weightedPctSum / activeWeightSum) * 10) / 10;
        return {
          earned: Math.round(totalEarned * 10) / 10,
          possible: Math.round(totalPossible * 10) / 10,
          percent: finalPct,
          isWeighted: true,
          categories: categoryBreakdown,
          activeWeight: activeWeightSum,
          weightedPctSum,
          letterGrade: getLetterGrade(finalPct),
        };
      }
    }

    // Flat unweighted points calculation
    let flatEarned = 0;
    let flatPossible = 0;
    for (const g of groupMap.values()) {
      for (const it of g.items) {
        flatEarned += it.earned;
        flatPossible += it.possible;
      }
    }
    for (const it of unassignedItems) {
      flatEarned += it.earned;
      flatPossible += it.possible;
    }

    if (flatPossible <= 0) return null;
    const finalPct = Math.round((flatEarned / flatPossible) * 1000) / 10;
    return {
      earned: Math.round(flatEarned * 10) / 10,
      possible: Math.round(flatPossible * 10) / 10,
      percent: finalPct,
      isWeighted: false,
      categories: [],
      letterGrade: getLetterGrade(finalPct),
    };
  }

  function computeOverallTermAverage() {
    const avgs = [];
    for (const c of state.courses) {
      const obj = computeCourseAverageObject(c.id, true);
      if (obj && obj.percent > 0) avgs.push(obj.percent);
    }
    if (avgs.length === 0) return `${state.courses.length} classes`;
    const mean = avgs.reduce((acc, v) => acc + v, 0) / avgs.length;
    const rounded = Math.round(mean * 10) / 10;
    return `${rounded}% (${getLetterGrade(rounded)})`;
  }

  function renderGameplanStrip(baseFilteredAssignments) {
    if (!els.gameplanStrip) return;

    const now = new Date();
    const nowMs = now.getTime();
    const currentHour = now.getHours();
    const currentMinutes = currentHour * 60 + now.getMinutes();

    // High school temporal context:
    // Classes dismiss at ~2:20 PM (860 mins). At 5:00 PM (1020 mins), school is concluded.
    const isSchoolDismissed = currentMinutes >= 865;
    const isBeforeSchool = currentMinutes < 445;

    const todayStr = now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toDateString();

    // Active in-class assessments strictly in the FUTURE:
    const upcomingAssessments = baseFilteredAssignments
      .filter((a) => isInClassAssessment(a) && !isAssignmentDone(a))
      .filter((a) => {
        const due = a.effective_due_at || a.due_at;
        if (!due) return false;
        return new Date(due).getTime() > nowMs;
      })
      .sort((a, b) => {
        const da = new Date(a.effective_due_at || a.due_at).getTime();
        const db = new Date(b.effective_due_at || b.due_at).getTime();
        return da - db;
      });

    // Collect verified physical supplies required for active coursework:
    const activeSupplies = [];
    const seenSupply = new Set();
    for (const a of baseFilteredAssignments) {
      if (isAssignmentDone(a)) continue;
      if (!a.is_active_context || a.is_archived_context) continue;
      if (Array.isArray(a.supplies)) {
        for (const s of a.supplies) {
          if (!seenSupply.has(s.name)) {
            seenSupply.add(s.name);
            const c = getCourseById(a.course_id);
            const cm = c ? parseCourseMeta(c) : { title: '' };
            activeSupplies.push({
              ...s,
              courseTitle: cm.title,
              assignmentName: a.name,
            });
          }
        }
      }
    }

    const unfinishedActive = baseFilteredAssignments
      .filter((a) => a.is_active_context && !a.is_archived_context && !isAssignmentDone(a))
      .sort((a, b) => getUrgencyInfo(a).sortWeight - getUrgencyInfo(b).sortWeight);

    let topHtml = '';
    const phaseLabel = isSchoolDismissed
      ? 'Evening Preparation · School Day Concluded'
      : isBeforeSchool
      ? 'Morning Routine · Before First Period'
      : 'Active School Day';

    if (unfinishedActive.length === 0) {
      topHtml = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full">
          <div>
            <p class="text-xs font-bold uppercase tracking-wider secondary-copy">${escapeHtml(phaseLabel)}</p>
            <p class="text-sm font-bold mt-0.5">All active coursework completed.</p>
          </div>
          <button type="button" id="gameplanBriefingsBtn" class="studio-btn text-xs font-semibold">
            Saved Briefings (${state.savedBriefingIds.size})
          </button>
        </div>
      `;
    } else {
      const topItem = unfinishedActive[0];
      const topCourse = getCourseById(topItem.course_id);
      const meta = topCourse ? parseCourseMeta(topCourse) : { title: 'Priority' };
      const u = getUrgencyInfo(topItem);

      topHtml = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full">
          <div class="space-y-0.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-bold uppercase tracking-wider text-[10px]" style="color: var(--accent);">Primary Task</span>
              <span class="secondary-copy">·</span>
              <span class="font-semibold secondary-copy">${escapeHtml(meta.title)}</span>
              <span class="${u.chipClass} tabular">${escapeHtml(u.label)}</span>
              ${topItem.naa_cutoff_at ? `<span class="context-tag tabular text-[10px] font-bold" style="border-color: #d97706; color: #d97706;">NAA Cutoff: ${new Date(topItem.naa_cutoff_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>` : ''}
            </div>
            <p class="text-base font-bold truncate">${escapeHtml(topItem.name)}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button type="button" id="gameplanFocusBtn" class="studio-btn studio-btn-primary text-xs py-2 px-3.5 font-bold">
              Focus 25m
            </button>
            <button type="button" id="gameplanBriefingsBtn" class="studio-btn tone-surface text-xs py-2 px-3 font-semibold">
              Saved Briefings (${state.savedBriefingIds.size})
            </button>
          </div>
        </div>
      `;
    }

    let assessmentBannerHtml = '';
    if (upcomingAssessments.length > 0) {
      const nextItem = upcomingAssessments[0];
      const nextDue = new Date(nextItem.effective_due_at || nextItem.due_at);
      const isToday = nextDue.toDateString() === todayStr;
      const isTomorrow = nextDue.toDateString() === tomorrowStr;
      const course = getCourseById(nextItem.course_id);
      const meta = course ? parseCourseMeta(course) : { title: 'Class', period: '' };
      const bell = getCourseBellInfo(nextItem.course_id);

      let timingLabel = '';
      let headerLabel = '';
      let borderClass = 'border-[var(--border-soft)]';

      if (isToday) {
        headerLabel = 'Assessment Today';
        timingLabel = `${meta.period || 'In-Class'} · ${bell.startText}`;
        borderClass = 'border-[var(--urgent)]';
      } else if (isTomorrow) {
        headerLabel = 'Assessment Tomorrow';
        timingLabel = `${meta.period || 'In-Class'} · ${bell.startText}`;
        borderClass = 'border-[var(--soon)]';
      } else {
        const daysAhead = Math.round((nextDue.getTime() - nowMs) / (86400 * 1000));
        const formattedDate = nextDue.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        headerLabel = `Scheduled Assessment · ${formattedDate} (${daysAhead} days)`;
        timingLabel = `${meta.period || 'In-Class'} · ${bell.startText}`;
      }

      assessmentBannerHtml = `
        <div class="w-full p-3.5 rounded tone-surface border-l-2 ${borderClass} space-y-1 mt-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold tracking-wider uppercase secondary-copy">${escapeHtml(headerLabel)}</span>
              <span class="context-tag tabular text-[10px] uppercase font-bold">${escapeHtml(timingLabel)}</span>
            </div>
            ${/calculus|derivative/i.test(nextItem.name) ? '<span class="context-tag text-[10px] uppercase font-bold tracking-wide">No Calculator</span>' : ''}
          </div>
          <p class="text-sm font-bold text-ink">${escapeHtml(nextItem.name)} <span class="secondary-copy font-normal">(${escapeHtml(meta.title)})</span></p>
          <p class="text-xs secondary-copy">${escapeHtml(nextItem.context_note || stripHtml(nextItem.description || '').slice(0, 160) || 'Review unit material and core formulas prior to testing.')}</p>
        </div>
      `;
    }

    let packlistHtml = '';
    if (activeSupplies.length > 0) {
      const packlistTitle = isSchoolDismissed ? 'Equipment & Materials for Next Class' : 'Backpack Packlist';
      packlistHtml = `
        <div class="w-full mt-2.5 p-3.5 tone-surface border-l-2 rounded space-y-2" style="border-left-color: var(--ink-secondary);">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-[var(--ink)] text-[var(--paper)]">SUPPLIES</span>
              <span class="text-xs font-bold uppercase tracking-wider">${escapeHtml(packlistTitle)}</span>
              <span class="text-xs secondary-copy tabular font-medium">· ${activeSupplies.length} items needed</span>
            </div>
            <span class="text-[11px] secondary-copy">Check off when packed</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
            ${activeSupplies
              .map((s) => {
                const isPacked = state.packedSupplyIds && state.packedSupplyIds.has(s.name);
                return `
                <label class="flex items-start gap-2.5 p-2 rounded cursor-pointer transition tone-surface-2 ${
                  isPacked ? 'opacity-50' : ''
                }" style="${isPacked ? 'text-decoration: line-through;' : ''}">
                  <input
                    type="checkbox"
                    data-toggle-pack="${escapeHtml(s.name)}"
                    ${isPacked ? 'checked' : ''}
                    class="mt-0.5 accent-neutral-800 shrink-0"
                  />
                  <div class="text-xs min-w-0">
                    <div class="font-bold truncate text-[12px] flex items-center gap-1.5">
                      <span class="text-[10px] font-bold uppercase tracking-wider secondary-copy">[${escapeHtml(s.tag)}]</span>
                      <span class="truncate">${escapeHtml(s.name)}</span>
                    </div>
                    <div class="text-[11px] secondary-copy truncate">${escapeHtml(s.courseTitle)}: ${escapeHtml(
                  s.reason
                )}</div>
                  </div>
                </label>`;
              })
              .join('')}
          </div>
        </div>
      `;
    }

    els.gameplanStrip.innerHTML = `
      <div class="w-full space-y-2">
        ${topHtml}
        ${assessmentBannerHtml}
        ${packlistHtml}
      </div>
    `;

    const fBtn = document.getElementById('gameplanFocusBtn');
    if (fBtn && unfinishedActive.length > 0) {
      fBtn.addEventListener('click', () => startFocusTimer(unfinishedActive[0].name));
    }
    const bBtn = document.getElementById('gameplanBriefingsBtn');
    if (bBtn) {
      bBtn.addEventListener('click', () => {
        renderSavedBriefingsDrawer();
        els.briefingsDrawerBackdrop.classList.remove('hidden');
      });
    }

    els.gameplanStrip.querySelectorAll('[data-toggle-pack]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const supplyName = cb.getAttribute('data-toggle-pack');
        if (!state.packedSupplyIds) state.packedSupplyIds = new Set();
        if (state.packedSupplyIds.has(supplyName)) {
          state.packedSupplyIds.delete(supplyName);
        } else {
          state.packedSupplyIds.add(supplyName);
        }
        setStoredItem('localStorage', 'slated_packed_supplies', JSON.stringify(Array.from(state.packedSupplyIds)));
        renderGameplanStrip(baseFilteredAssignments);
      });
    });
  }

  function formatClock(h, m) {
    const d = new Date(2000, 0, 1, h, m);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function toTimeInputValue(h, m) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function applyPeriodTimes(key, startVal, endVal) {
    const p = scheduleConfig.periods[key];
    if (!p || !/^\d{2}:\d{2}$/.test(startVal) || !/^\d{2}:\d{2}$/.test(endVal)) return;
    const [sh, sm] = startVal.split(':').map(Number);
    const [eh, em] = endVal.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) return;
    p.startHour = sh;
    p.startMin = sm;
    p.endHour = eh;
    p.endMin = em;
    p.startText = formatClock(sh, sm);
    p.endText = formatClock(eh, em);
    p.rangeText = `${p.startText} – ${p.endText}`;
  }

  function renderBellScheduleStrip() {
    if (!els.bellScheduleStrip) return;
    const wasOpen = Boolean(els.bellScheduleStrip.querySelector('details[data-bell-root][open]'));
    const now = new Date();
    const minsNow = now.getHours() * 60 + now.getMinutes();
    const todayType = getSchoolDayType(now);

    // Next school day (today if before final bell)
    const p4 = scheduleConfig.periods.P4;
    let target = new Date(now);
    if (!todayType || minsNow > p4.endHour * 60 + p4.endMin) {
      for (let i = 1; i <= 7; i++) {
        const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        if (getSchoolDayType(cand)) {
          target = cand;
          break;
        }
      }
    }
    const targetType = getSchoolDayType(target);
    const isToday = target.toDateString() === now.toDateString();
    const targetLabel = `${isToday ? 'Today' : target.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${targetType ? ` • ${targetType} Day` : ''}`;

    const metas = state.courses.map((c) => ({ course: c, meta: parseCourseMeta(c) }));
    const forPeriod = (pNum) =>
      metas.filter(({ meta }) => meta.basePeriod === `P${pNum}` && meta.block !== 'Class');

    // Today's actual sequence (the class you attend in each period on that day)
    const sequence = [1, 2, 3, 4]
      .map((n) => {
        const list = forPeriod(n);
        const pick =
          list.find(({ meta }) => meta.abDay && meta.abDay === targetType) ||
          list.find(({ meta }) => !meta.abDay);
        if (!pick) return null;
        const bell = getPeriodBellObject(`P${n}`, pick.meta.lunchWave);
        const startM = bell.startHour * 60 + bell.startMin;
        const endM = bell.endHour * 60 + bell.endMin;
        return {
          n,
          meta: pick.meta,
          bell,
          isNow: isToday && minsNow >= startM && minsNow <= endM,
        };
      })
      .filter(Boolean);

    const summaryLine = sequence.length
      ? sequence
          .map(
            (s) =>
              `${s.meta.block} ${s.meta.title.replace(/\s+Honors$/i, ' H')} ${s.bell.startText.replace(/\s?[AP]M$/i, '')}`
          )
          .join('  ·  ')
      : 'Add your periods below to align deadlines to your bell schedule';

    const periodCard = (n) => {
      const list = forPeriod(n);
      const bell = getPeriodBellObject(`P${n}`);
      const isP3 = n === 3;
      const rows = list.length
        ? list
            .map(({ meta }) => {
              const active = !meta.abDay || meta.abDay === targetType;
              return `
              <div class="p-2 tone-surface flex items-start justify-between gap-2" style="${active ? '' : 'opacity:0.6;'}">
                <div class="min-w-0">
                  <p class="font-bold truncate">${escapeHtml(meta.block)} · ${escapeHtml(meta.title)}</p>
                  <p class="secondary-copy truncate">${escapeHtml(
                    [meta.teacher, meta.room ? `Rm ${meta.room}` : '', meta.building].filter(Boolean).join(' · ')
                  )}</p>
                </div>
                ${meta.abDay ? `<span class="context-tag shrink-0">${meta.abDay} Day</span>` : ''}
              </div>`;
            })
            .join('')
        : '<p class="secondary-copy px-1">No class detected</p>';
      return `
        <div class="p-3.5 tone-surface-2 space-y-2 text-xs">
          <div class="flex items-center justify-between font-bold">
            <span style="color: var(--accent);">Period ${n}</span>
            <span class="tabular secondary-copy">${escapeHtml(bell.rangeText)}</span>
          </div>
          ${rows}
          ${
            isP3
              ? `<p class="text-[11px] secondary-copy px-1">Lunch ${escapeHtml(bell.lunchRangeText || '')} · ${escapeHtml(bell.shortLunchLabel || '')}</p>`
              : ''
          }
        </div>`;
    };

    const lunchWave = scheduleConfig.p3LunchMode || '2nd';
    const timeRow = (key, label) => {
      const p = scheduleConfig.periods[key];
      return `
        <div class="grid grid-cols-12 gap-2 items-center">
          <span class="col-span-4 font-semibold">${escapeHtml(label)}</span>
          <input type="time" data-cfg-start="${key}" value="${toTimeInputValue(p.startHour, p.startMin)}" class="col-span-4 studio-input text-xs py-1" />
          <input type="time" data-cfg-end="${key}" value="${toTimeInputValue(p.endHour, p.endMin)}" class="col-span-4 studio-input text-xs py-1" />
        </div>`;
    };

    els.bellScheduleStrip.innerHTML = `
      <details data-bell-root class="studio-dropdown tone-surface" ${wasOpen ? 'open' : ''}>
        <summary class="p-3.5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="status-dot ${sequence.some((s) => s.isNow) ? 'status-dot-green' : ''}"></span>
            <div class="min-w-0">
              <p class="text-xs font-bold">${escapeHtml(scheduleConfig.schoolName)} · ${escapeHtml(targetLabel)}</p>
              <p class="text-[11px] secondary-copy truncate tabular">${escapeHtml(summaryLine)}</p>
            </div>
          </div>
          <span class="studio-btn tone-surface-2 text-xs py-1 px-2.5">
            <span>Schedule &amp; Rooms</span>
            <span class="dropdown-chevron text-[10px]">▾</span>
          </span>
        </summary>

        <div class="p-4 pt-3 space-y-4" style="border-top: 1px solid var(--surface-2);">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            ${[1, 2, 3, 4].map(periodCard).join('')}
          </div>

          <details class="studio-dropdown text-xs">
            <summary class="inline-flex items-center gap-1.5 font-semibold secondary-copy">
              <span>Edit bell times, lunch &amp; rooms</span>
              <span class="dropdown-chevron text-[10px]">▾</span>
            </summary>
            <div class="mt-3 p-4 tone-surface-2 space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div class="space-y-2">
                  <label class="block font-bold">School</label>
                  <input id="cfgSchoolNameInput" type="text" value="${escapeHtml(scheduleConfig.schoolName)}" class="studio-input text-xs py-1.5" />
                  <div class="grid grid-cols-12 gap-2 pt-2 secondary-copy text-[11px]">
                    <span class="col-span-4">Period</span><span class="col-span-4">Start</span><span class="col-span-4">End</span>
                  </div>
                  ${timeRow('P1', 'Period 1')}
                  ${timeRow('P2', 'Period 2')}
                  ${timeRow('P3_2ND', 'P3 · 2nd lunch')}
                  ${timeRow('P3_1ST', 'P3 · 1st lunch')}
                  ${timeRow('P4', 'Period 4')}
                  <label class="flex items-center justify-between gap-2 pt-2">
                    <span class="font-semibold">Default P3 lunch (when room is unknown)</span>
                    <select id="cfgLunchSelect" class="studio-select text-xs py-1">
                      <option value="2nd" ${lunchWave === '2nd' ? 'selected' : ''}>2nd lunch</option>
                      <option value="1st" ${lunchWave === '1st' ? 'selected' : ''}>1st lunch</option>
                    </select>
                  </label>
                </div>
                <div class="space-y-2">
                  <label class="block font-bold">Your classes</label>
                  <div class="grid grid-cols-12 gap-2 secondary-copy text-[11px]">
                    <span class="col-span-6">Class</span><span class="col-span-3">Block</span><span class="col-span-3">Room</span>
                  </div>
                  ${metas
                    .map(
                      ({ course, meta }) => `
                    <div class="grid grid-cols-12 gap-2 items-center">
                      <span class="col-span-6 truncate font-semibold" title="${escapeHtml(meta.title)}">${escapeHtml(meta.title)}</span>
                      <input type="text" maxlength="3" data-cfg-block="${escapeHtml(course.id)}" value="${escapeHtml(meta.block === 'Class' ? '' : meta.block)}" placeholder="1A" class="col-span-3 studio-input text-xs py-1 uppercase" />
                      <input type="text" maxlength="5" data-cfg-room="${escapeHtml(course.id)}" value="${escapeHtml(meta.room || '')}" placeholder="—" class="col-span-3 studio-input text-xs py-1" />
                    </div>`
                    )
                    .join('')}
                  <p class="text-[11px] secondary-copy pt-1">Blocks use period + day, e.g. 1A, 2B, or P3 for every-day classes.</p>
                </div>
              </div>
              <div class="flex items-center justify-between pt-1" style="border-top: 1px solid var(--surface); padding-top: 0.75rem;">
                <button type="button" id="resetScheduleCfgBtn" class="underline secondary-copy">Reset to detected</button>
                <button type="button" id="saveScheduleCfgBtn" class="studio-btn studio-btn-primary text-xs py-1.5 px-3">Save</button>
              </div>
            </div>
          </details>
        </div>
      </details>
    `;

    const saveCfgBtn = document.getElementById('saveScheduleCfgBtn');
    if (saveCfgBtn) {
      saveCfgBtn.addEventListener('click', () => {
        const root = els.bellScheduleStrip;
        const sName = document.getElementById('cfgSchoolNameInput');
        if (sName && sName.value.trim()) scheduleConfig.schoolName = sName.value.trim().slice(0, 80);
        root.querySelectorAll('[data-cfg-start]').forEach((inp) => {
          const key = inp.getAttribute('data-cfg-start');
          const endInp = root.querySelector(`[data-cfg-end="${key}"]`);
          if (endInp) applyPeriodTimes(key, inp.value, endInp.value);
        });
        const lunchSel = document.getElementById('cfgLunchSelect');
        if (lunchSel) scheduleConfig.p3LunchMode = lunchSel.value === '1st' ? '1st' : '2nd';
        const overrides = {};
        root.querySelectorAll('[data-cfg-block]').forEach((inp) => {
          const cid = inp.getAttribute('data-cfg-block');
          const roomInp = root.querySelector(`[data-cfg-room="${cid}"]`);
          const block = inp.value.trim().toUpperCase();
          const room = roomInp ? roomInp.value.trim().replace(/[^\w-]/g, '') : '';
          const entry = {};
          if (/^P?\d[AB]?$/.test(block)) entry.block = block;
          if (room) entry.room = room;
          if (entry.block || entry.room) overrides[cid] = entry;
        });
        scheduleConfig.courseOverrides = overrides;
        saveScheduleConfig();
        showToast('Schedule saved. Deadlines re-aligned.');
        renderAll();
      });
    }

    const resetCfgBtn = document.getElementById('resetScheduleCfgBtn');
    if (resetCfgBtn) {
      resetCfgBtn.addEventListener('click', () => {
        scheduleConfig = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_CONFIG));
        saveScheduleConfig();
        showToast('Schedule reset to detected values.');
        renderAll();
      });
    }
  }

  function renderMetricsAndCounts(baseFilteredAssignments) {
    const now = Date.now();
    const hr48 = 48 * 3600 * 1000;
    const day7 = 7 * 24 * 3600 * 1000;

    let urgentCount = 0;
    let weekCount = 0;
    let doneCount = 0;
    let activeWindowCount = 0;
    let todoOnlyCount = 0;
    let archivedCount = 0;
    let needsActionCount = 0;

    for (const a of baseFilteredAssignments) {
      const done = isAssignmentDone(a);
      const isActive = a.is_active_context && !a.is_archived_context;

      if (a.is_archived_context && !done) {
        archivedCount++;
      }
      if (isActive) {
        activeWindowCount++;
      }
      if (done) {
        doneCount++;
      } else if (isActive) {
        todoOnlyCount++;
      }

      const dueIso = a.effective_due_at || a.due_at;
      if (dueIso && !done) {
        const diff = new Date(dueIso).getTime() - now;
        if (diff < 0) {
          needsActionCount++; // Past due without submission
        }
        if (isActive) {
          if (diff >= -24 * 3600 * 1000 && diff <= hr48) urgentCount++;
          if (diff >= 0 && diff <= day7) weekCount++;
        }
      }
    }

    if (els.statActiveCourses) {
      els.statActiveCourses.textContent = needsActionCount === 0 ? '0' : String(needsActionCount);
      els.statActiveCourses.style.color = needsActionCount > 0 ? 'var(--urgent)' : 'var(--calm)';
      els.statActiveCourses.title = needsActionCount === 0 ? 'All caught up! Zero unsubmitted past assignments.' : `${needsActionCount} past-due assignments require attention or makeup.`;
    }

    if (els.statUrgentAssignments) els.statUrgentAssignments.textContent = String(urgentCount);
    if (els.statWeekAssignments) els.statWeekAssignments.textContent = String(weekCount);
    if (els.statDoneAssignments) els.statDoneAssignments.textContent = String(doneCount);

    if (els.countUpcomingBadge) els.countUpcomingBadge.textContent = String(baseFilteredAssignments.length);
    if (els.countUrgentBadge) els.countUrgentBadge.textContent = String(urgentCount);
    if (els.countWeekBadge) els.countWeekBadge.textContent = String(weekCount);
    if (els.countTodoBadge) els.countTodoBadge.textContent = String(todoOnlyCount);
    if (els.countCompletedBadge) els.countCompletedBadge.textContent = String(doneCount);
    if (els.countAllBadge) els.countAllBadge.textContent = String(archivedCount);
  }

  function renderCourseSelectors() {
    const current = state.selectedCourseId;
    const optionsHtml = [
      '<option value="all">All Classes</option>',
      ...state.courses.map((c) => {
        const meta = parseCourseMeta(c);
        const label = meta.period !== 'Class' ? `${meta.period} • ${meta.title}` : meta.title;
        return `<option value="${escapeHtml(c.id)}">${escapeHtml(label)}</option>`;
      }),
    ].join('');
    els.courseFilterSelect.innerHTML = optionsHtml;
    els.courseFilterSelect.value = current;

    if (els.customTaskCourse) {
      els.customTaskCourse.innerHTML = [
        '<option value="custom">General</option>',
        ...state.courses.map((c) => {
          const meta = parseCourseMeta(c);
          return `<option value="${escapeHtml(c.id)}">${escapeHtml(meta.title)}</option>`;
        }),
      ].join('');
    }

    if (els.resetCourseFilterBtn) {
      els.resetCourseFilterBtn.classList.toggle('hidden', current === 'all' && !state.searchQuery);
    }
  }

  function renderCourseCards() {
    const visibleCourses = state.courses.filter((c) => {
      if (!state.searchQuery) return true;
      const q = state.searchQuery.toLowerCase();
      return (
        String(c.name || '').toLowerCase().includes(q) ||
        String(c.course_code || '').toLowerCase().includes(q)
      );
    });

    if (visibleCourses.length === 0) {
      els.courseCardsGrid.innerHTML = `
        <div class="col-span-full p-6 tone-surface-2">
          <p class="font-bold">No classes match your search.</p>
        </div>`;
      return;
    }

    const allCombined = getCombinedAssignments();

    els.courseCardsGrid.innerHTML = visibleCourses
      .map((course) => {
        const cid = String(course.id);
        const isSelected = String(state.selectedCourseId) === cid;
        const meta = parseCourseMeta(course);
        const ctx = state.courseContexts[cid] || { activeUnitLabel: 'Active Term' };

        const dueSoonCount = allCombined.filter(
          (a) =>
            String(a.course_id) === cid &&
            a.is_active_context &&
            !a.is_archived_context &&
            !isAssignmentDone(a)
        ).length;

        const annCount = state.announcements.filter(
          (ann) => String(ann.context_code || '').replace(/^course_/, '') === cid
        ).length;

        const avgObj = computeCourseAverageObject(cid, true);
        const gradeBadge = avgObj && avgObj.percent != null
          ? `<span class="grade-category-pill" title="${avgObj.isWeighted ? 'Weighted Category Grade' : 'Total Points Grade'}">
              <strong>${avgObj.percent}%</strong> (${avgObj.letterGrade})${avgObj.isWeighted ? ' • Weighted' : ''}
            </span>`
          : '';
        const topGradeText = avgObj && avgObj.percent != null
          ? `${avgObj.percent}% (${avgObj.letterGrade})`
          : (dueSoonCount === 0 ? 'Caught up' : `${dueSoonCount} to-do`);
        const courseUrl = safeHttpUrl(course.html_url || `${state.canvasBaseUrl}/courses/${course.id}`) || '#';

        return `
          <article
            data-course-card="${escapeHtml(course.id)}"
            class="cursor-pointer p-5 tone-surface-2 flex flex-col justify-between transition"
            style="${
              isSelected ? 'outline: 2px solid var(--accent); outline-offset: -2px;' : ''
            }"
          >
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2 text-xs font-bold" style="color: var(--ink-secondary);">
                <span>${escapeHtml(meta.period)}${meta.room ? ` • Rm ${escapeHtml(meta.room)}` : ''}${meta.lunchWave ? ` (${meta.lunchWave} Lunch)` : ''}${meta.teacher ? ` • ${escapeHtml(meta.teacher)}` : ''}</span>
                <span class="tabular font-bold" style="color: var(--ink);">${escapeHtml(topGradeText)}</span>
              </div>
              <h3 class="text-base font-bold leading-snug">
                ${escapeHtml(meta.title)}
              </h3>
              <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span class="context-tag truncate max-w-full" title="${escapeHtml(ctx.activeUnitLabel)}">
                  ${escapeHtml(ctx.activeUnitLabel)}
                </span>
                ${gradeBadge}
                ${
                  annCount > 0
                    ? `<span class="context-tag tabular">${annCount} briefings</span>`
                    : ''
                }
              </div>
            </div>

            <div class="mt-5 pt-3 flex items-center justify-between text-xs font-semibold" style="border-top: 1px solid var(--surface);">
              <span class="tabular">
                ${dueSoonCount === 0 ? 'All caught up' : `${dueSoonCount} active to-do`}
              </span>
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  data-open-inspector="${escapeHtml(course.id)}"
                  class="underline font-bold"
                  style="color: var(--ink);"
                >
                  What-If Grade Lab
                </button>
                <a
                  href="${escapeHtml(courseUrl)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  onclick="event.stopPropagation()"
                  class="underline hover:opacity-80"
                  style="color: var(--accent);"
                >
                  Canvas
                </a>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    els.courseCardsGrid.querySelectorAll('[data-course-card]').forEach((card) => {
      card.addEventListener('click', () => {
        const cid = card.getAttribute('data-course-card');
        state.selectedCourseId = String(state.selectedCourseId) === String(cid) ? 'all' : cid;
        renderCourseSelectors();
        renderAll();
      });
    });

    els.courseCardsGrid.querySelectorAll('[data-open-inspector]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCourseInspector(btn.getAttribute('data-open-inspector'), 'gradelab');
      });
    });
  }

  function renderTaskCard(assignment) {
    const course = getCourseById(assignment.course_id);
    const meta = course ? parseCourseMeta(course) : { period: '', title: 'Personal Reminder' };
    const courseLabel =
      meta.period && meta.period !== 'Class' ? `${meta.period} • ${meta.title}` : meta.title;
    const urgency = getUrgencyInfo(assignment);
    const done = isAssignmentDone(assignment);
    const assignmentUrl =
      assignment.html_url ||
      (assignment.course_id && assignment.course_id !== 'custom'
        ? `${state.canvasBaseUrl}/courses/${assignment.course_id}/assignments/${assignment.id}`
        : null);
    const points =
      assignment.points_possible != null && assignment.points_possible > 0
        ? `${assignment.points_possible} pts`
        : '';
    const summary = stripHtml(assignment.description).slice(0, 145);

    const filesHtml =
      Array.isArray(assignment.attachments) && assignment.attachments.length > 0
        ? `<div class="pt-1 flex flex-wrap gap-1.5">
            ${assignment.attachments
              .map(
                (f) =>
                  `<a href="${escapeHtml(
                    safeHttpUrl(f.url) || '#'
                  )}" target="_blank" rel="noopener noreferrer" class="context-tag hover:underline" style="color: var(--accent);">${escapeHtml(
                    f.display_name
                  )}</a>`
              )
              .join('')}
          </div>`
        : '';

    return `
      <article id="task-card-${escapeHtml(assignment.id)}" class="p-4 tone-surface ${urgency.stripClass} flex flex-col sm:flex-row sm:items-center justify-between gap-4" style="${
        done ? 'opacity: 0.78;' : ''
      }">
        <div class="flex items-start gap-3.5">
          <button
            type="button"
            data-toggle-done="${escapeHtml(assignment.id)}"
            class="mt-1 w-5 h-5 shrink-0 flex items-center justify-center text-xs font-bold transition"
            style="border: 2px solid ${done ? 'var(--calm)' : 'var(--ink-secondary)'}; background-color: ${
              done ? 'var(--calm)' : 'transparent'
            }; color: #fff;"
            title="${done ? 'Mark as unfinished' : 'Mark as done'}"
            aria-label="${done ? 'Mark as unfinished' : 'Mark as done'}"
          >
            ${done ? '✓' : ''}
          </button>

          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="${urgency.chipClass} tabular">
                <span class="${urgency.dotClass}"></span>
                ${escapeHtml(urgency.label)}
              </span>
              <span class="text-xs font-bold" style="color: var(--ink-secondary);">
                ${escapeHtml(courseLabel)}
              </span>
              ${
                assignment.context_badge
                  ? `<span class="context-tag ${
                      assignment.is_announcement_event || assignment.context_note
                        ? 'context-tag-accent'
                        : ''
                    }">${escapeHtml(assignment.context_badge)}</span>`
                  : ''
              }
              ${
                !done && assignment.effort_label
                  ? `<span class="context-tag tabular">${escapeHtml(
                      assignment.effort_label
                    )}</span>`
                  : ''
              }
              ${
                points
                  ? `<span class="text-xs tabular" style="color: var(--ink-secondary);">${escapeHtml(
                      points
                    )}</span>`
                  : ''
              }
              ${
                assignment.assignment_kind_badge
                  ? `<span class="context-tag uppercase text-[10px] font-bold ${
                      assignment.is_in_class_assessment ? 'context-tag-accent' : ''
                    }">${escapeHtml(assignment.assignment_kind_badge)}</span>`
                  : ''}
              ${
                /calculus|derivative/i.test(assignment.name)
                  ? '<span class="context-tag text-[10px] uppercase font-bold tracking-wide">No Calculator</span>'
                  : ''
              }
              ${
                assignment.naa_cutoff_at
                  ? `<span class="context-tag tabular text-[10px] font-bold" style="border-color: #d97706; color: #d97706;">NAA Cutoff: ${new Date(assignment.naa_cutoff_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>`
                  : ''
              }
              ${
                Array.isArray(assignment.supplies) && assignment.supplies.length > 0
                  ? `<span class="context-tag font-semibold" style="border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.08); color: #d97706;" title="${escapeHtml(
                      assignment.supplies.map((s) => `${s.icon} ${s.name}: ${s.reason}`).join(' | ')
                    )}">Supplies: ${escapeHtml(
                      assignment.supplies.slice(0, 2).map((s) => s.name).join(' · ')
                    )}${assignment.supplies.length > 2 ? ` +${assignment.supplies.length - 2}` : ''}</span>`
                  : ''
              }
            </div>

            <h3 class="text-base font-bold leading-snug" style="${
              done ? 'text-decoration: line-through;' : ''
            }">
              ${
                assignmentUrl
                  ? `<a href="${escapeHtml(
                      safeHttpUrl(assignmentUrl) || '#'
                    )}" target="_blank" rel="noopener noreferrer" class="hover:underline">${escapeHtml(
                      assignment.name
                    )}</a>`
                  : escapeHtml(assignment.name)
              }
            </h3>

            ${
              assignment.context_note ||
              (summary && summary !== 'Personal reminder') ||
              filesHtml ||
              (Array.isArray(assignment.deliverable_checklist) && assignment.deliverable_checklist.length > 0) ||
              (Array.isArray(assignment.supplies) && assignment.supplies.length > 0) ||
              (Array.isArray(assignment.accelerators) && assignment.accelerators.length > 0)
                ? `<details class="studio-dropdown mt-2 text-xs">
                    <summary class="inline-flex items-center gap-1.5 cursor-pointer font-semibold secondary-copy hover:text-ink">
                      <span>Details, Supplies &amp; Reference</span>
                      <span class="dropdown-chevron text-[10px]">▾</span>
                    </summary>
                    <div class="pt-2 space-y-2">
                      ${
                        assignment.context_note
                          ? `<p class="font-semibold" style="color: var(--accent);">${escapeHtml(
                              assignment.context_note
                            )}</p>`
                          : ''
                      }
                      ${
                        Array.isArray(assignment.deliverable_checklist) && assignment.deliverable_checklist.length > 0
                          ? `<div class="p-2.5 rounded bg-black/5 dark:bg-white/5 border border-dashed border-[var(--border-soft)] space-y-1">
                              <div class="text-[11px] font-bold uppercase tracking-wider text-[var(--accent)] flex items-center gap-1">
                                <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">Deliverables &amp; Rubric Checklist</span>
                              </div>
                              <ul class="list-disc list-inside space-y-0.5 text-xs">
                                ${assignment.deliverable_checklist
                                  .map((item) => `<li class="secondary-copy">${escapeHtml(item)}</li>`)
                                  .join('')}
                              </ul>
                            </div>`
                          : ''
                      }
                      ${
                        Array.isArray(assignment.supplies) && assignment.supplies.length > 0
                          ? `<div class="p-2 rounded bg-amber-500/10 border border-amber-500/20 space-y-1">
                              <div class="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">Physical Supplies to Prepare</span>
                              </div>
                              <div class="flex flex-wrap gap-1.5 pt-0.5">
                                ${assignment.supplies
                                  .map(
                                    (s) =>
                                      `<span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium" title="${escapeHtml(s.reason)}">
                                        <span>${escapeHtml(s.name)}</span>
                                      </span>`
                                  )
                                  .join('')}
                              </div>
                            </div>`
                          : ''
                      }
                      ${
                        Array.isArray(assignment.accelerators) && assignment.accelerators.length > 0
                          ? `<div class="p-2.5 rounded bg-black/5 dark:bg-white/5 border border-[var(--border-soft)] space-y-1.5">
                              <div class="text-[11px] font-bold uppercase tracking-wider text-[var(--accent)] flex items-center gap-1">
                                <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">Reference &amp; Study Guides</span>
                              </div>
                              <div class="flex flex-wrap gap-1.5 pt-1">
                                ${assignment.accelerators
                                  .map(
                                    (g) =>
                                      `<a
                                        href="${escapeHtml(safeHttpUrl(g.url) || '#')}"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded tone-surface hover:opacity-80 transition"
                                        style="border: 1px solid var(--border-soft); text-decoration: none;"
                                      >
                                        <span>${escapeHtml(g.title)}</span>
                                        <span class="text-[10px] opacity-75 font-normal">(${escapeHtml(g.type)})</span>
                                        <span class="text-[10px]">↗</span>
                                      </a>`
                                  )
                                  .join('')}
                              </div>
                            </div>`
                          : ''
                      }
                      ${
                        summary && summary !== 'Personal reminder'
                          ? `<p class="secondary-copy">${escapeHtml(summary)}</p>`
                          : ''
                      }
                      ${filesHtml}
                    </div>
                  </details>`
                : ''
            }
          </div>
        </div>

        <div class="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0 pl-8 sm:pl-0">
          <span class="text-xs font-semibold tabular">
            ${escapeHtml(formatDateTime(assignment.effective_due_at || assignment.due_at))}
          </span>
          <div class="flex flex-wrap items-center gap-2.5 text-xs font-bold">
            ${
              assignment.study_deck_link
                ? `<button
                    type="button"
                    data-open-study-deck="${escapeHtml(assignment.study_deck_link)}"
                    class="underline font-bold"
                    style="color: var(--accent);"
                  >
                    Check answers
                  </button>`
                : ''
            }
            <button
              type="button"
              data-add-gcal="${escapeHtml(assignment.id)}"
              class="underline hover:opacity-80"
              style="color: var(--ink-secondary);"
              title="Add to Google Calendar with bell schedule"
            >
              + Google Cal
            </button>
            <button
              type="button"
              data-copy-link="${escapeHtml(assignmentUrl || '')}"
              class="underline hover:opacity-80"
              style="color: var(--ink-secondary);"
              title="Copy Canvas link to clipboard"
            >
              Copy Link
            </button>
            <button
              type="button"
              data-focus-task="${escapeHtml(assignment.name)}"
              class="underline hover:opacity-80"
              style="color: var(--ink-secondary);"
            >
              Focus 25m
            </button>
            ${
              !assignment.is_custom && assignment.course_id && assignment.id
                ? `<button
                    type="button"
                    data-submit-assignment="${escapeHtml(assignment.id)}"
                    data-course-id="${escapeHtml(assignment.course_id)}"
                    class="studio-btn text-xs py-1 px-2.5 font-bold"
                    style="background: var(--ink); color: #fff;"
                    title="Submit directly to Canvas without leaving Slated"
                  >
                    ${done ? 'Resubmit' : 'Turn In ↗'}
                  </button>`
                : ''
            }
            ${
              assignment.is_custom
                ? `<button type="button" data-delete-custom="${escapeHtml(
                    assignment.id
                  )}" class="underline" style="color: var(--urgent);">Delete</button>`
                : assignmentUrl
                ? `<a href="${escapeHtml(
                    safeHttpUrl(assignmentUrl) || '#'
                  )}" target="_blank" rel="noopener noreferrer" class="underline" style="color: var(--accent);">Canvas</a>`
                : ''
            }
            ${
              isPastInClassAssessment(assignment) && done
                ? `<button
                    type="button"
                    data-toggle-retake="${escapeHtml(assignment.id)}"
                    class="underline text-xs font-semibold"
                    style="color: var(--urgent);"
                    title="Mark as absent or needing a retake to restore to active queue"
                  >
                    Absent / Need Retake?
                  </button>`
                : state.inClassRetakeIds && state.inClassRetakeIds.has(String(assignment.id))
                ? `<button
                    type="button"
                    data-toggle-retake="${escapeHtml(assignment.id)}"
                    class="studio-btn text-xs py-1 px-2.5 font-bold"
                    style="background: var(--calm); color: #fff;"
                    title="Mark as completed in class"
                  >
                    ✓ Mark Taken in Class
                  </button>`
                : ''
            }
          </div>
        </div>
      </article>
    `;
  }

  function setAssignmentHorizon(h) {
    state.assignmentHorizon = h || 'all';
    document.querySelectorAll('.horizon-btn').forEach((b) => {
      const match = b.getAttribute('data-horizon') === state.assignmentHorizon;
      b.classList.toggle('studio-btn-primary', match);
    });
    renderAll();
  }

  function renderAssignments(baseFilteredAssignments) {
    const now = Date.now();
    const hr48 = 48 * 3600 * 1000;
    const day7 = 7 * 86400 * 1000;

    const urgentItems = [];
    const weekItems = [];
    const upcomingItems = [];
    const completedItems = [];
    const archivedItems = [];

    for (const a of baseFilteredAssignments) {
      const done = isAssignmentDone(a);
      if (done) {
        completedItems.push(a);
        continue;
      }

      const dueIso = a.effective_due_at || a.due_at;
      const dueMs = dueIso ? new Date(dueIso).getTime() : null;
      const diffMs = dueMs ? dueMs - now : null;
      const daysAgo = diffMs != null && diffMs < 0 ? Math.abs(diffMs) / (86400 * 1000) : 0;

      // Unsubmitted items overdue by more than 14 days belong in archive/past units
      if (a.is_archived_context || (dueMs && daysAgo > 14)) {
        archivedItems.push(a);
        continue;
      }

      const isRetake = state.inClassRetakeIds && state.inClassRetakeIds.has(String(a.id));
      const isInClassToday = isInClassAssessment(a) && !isPastInClassAssessment(a);

      if (isRetake || isInClassToday) {
        urgentItems.push(a);
        continue;
      }

      if (!dueIso || Number.isNaN(dueMs)) {
        upcomingItems.push(a);
        continue;
      }

      if (diffMs <= hr48) {
        urgentItems.push(a);
      } else if (diffMs <= day7) {
        weekItems.push(a);
      } else {
        upcomingItems.push(a);
      }
    }

    const sortActive = (arr) => arr.sort((a, b) => getUrgencyInfo(a).sortWeight - getUrgencyInfo(b).sortWeight);
    sortActive(urgentItems);
    sortActive(weekItems);
    sortActive(upcomingItems);

    const sortDone = (arr) =>
      arr.sort((a, b) => {
        const da = a.effective_due_at || a.due_at || a.created_at ? new Date(a.effective_due_at || a.due_at || a.created_at).getTime() : 0;
        const db = b.effective_due_at || b.due_at || b.created_at ? new Date(b.effective_due_at || b.due_at || b.created_at).getTime() : 0;
        return db - da;
      });
    sortDone(completedItems);
    sortDone(archivedItems);

    const bucketsToRender = [];

    if (state.assignmentHorizon === 'urgent') {
      bucketsToRender.push({
        id: 'urgent',
        title: 'Urgent Deadlines (< 48h / Overdue)',
        subtitle: 'High action priority',
        dotClass: 'status-dot-red',
        items: urgentItems,
        emptyText: 'No urgent deadlines within the next 48 hours. Excellent pacing!',
      });
    } else if (state.assignmentHorizon === 'week') {
      bucketsToRender.push({
        id: 'week',
        title: 'This Week (Next 2–7 Days)',
        subtitle: 'Upcoming milestones',
        dotClass: 'status-dot-yellow',
        items: weekItems,
        emptyText: 'No assignments due in the 2–7 day window.',
      });
    } else if (state.assignmentHorizon === 'upcoming' || state.assignmentHorizon === 'todo_only') {
      bucketsToRender.push({
        id: 'upcoming',
        title: 'Upcoming & Open Unit Work',
        subtitle: 'Later deadlines & active units',
        dotClass: 'status-dot-green',
        items: upcomingItems,
        emptyText: 'No later upcoming deadlines found.',
      });
    } else if (state.assignmentHorizon === 'completed') {
      bucketsToRender.push({
        id: 'completed',
        title: 'Completed & Submitted Work',
        subtitle: 'Turned in and graded items',
        dotClass: 'status-dot-green',
        items: completedItems,
        emptyText: 'No completed assignments recorded yet.',
      });
    } else if (state.assignmentHorizon === 'archived') {
      bucketsToRender.push({
        id: 'archived',
        title: 'Archived Terms & Units',
        subtitle: 'Previous quarter context',
        dotClass: 'status-dot-green',
        items: archivedItems,
        emptyText: 'No archived items in this view.',
      });
    } else {
      // 'all': Unified Action Queue (Active tasks: Urgent, This Week, Upcoming)
      // Completed and archived items are accessed under their dedicated horizon tabs
      bucketsToRender.push(
        {
          id: 'urgent',
          title: 'Urgent Deadlines (< 48h / Overdue)',
          subtitle: 'High action priority',
          dotClass: 'status-dot-red',
          items: urgentItems,
          emptyText: 'All clear! No urgent assignments due in the next 48 hours.',
        },
        {
          id: 'week',
          title: 'This Week (Next 2–7 Days)',
          subtitle: 'Active preparation queue',
          dotClass: 'status-dot-yellow',
          items: weekItems,
          emptyText: 'No assignments due in days 2 through 7.',
        },
        {
          id: 'upcoming',
          title: 'Upcoming & Open Unit Work',
          subtitle: 'Longer horizon & open units',
          dotClass: 'status-dot-green',
          items: upcomingItems,
          emptyText: 'No upcoming assignments scheduled beyond this week.',
        }
      );
    }

    // Update left sidebar counter badges
    if (els.countUpcomingBadge) els.countUpcomingBadge.textContent = urgentItems.length + weekItems.length + upcomingItems.length;
    if (els.countUrgentBadge) els.countUrgentBadge.textContent = urgentItems.length;
    if (els.countWeekBadge) els.countWeekBadge.textContent = weekItems.length;
    if (els.countTodoBadge) els.countTodoBadge.textContent = upcomingItems.length;
    if (els.countCompletedBadge) els.countCompletedBadge.textContent = completedItems.length;
    if (els.countAllBadge) els.countAllBadge.textContent = archivedItems.length;

    const totalShown = bucketsToRender.reduce((sum, b) => sum + b.items.length, 0);
    if (totalShown === 0) {
      els.assignmentsList.innerHTML = `
        <div class="p-8 tone-surface space-y-2">
          <p class="text-base font-bold">🎉 You're all caught up!</p>
          <p class="secondary-copy text-sm">No tasks due in this view. Check "Submitted & Graded" on the left to see completed work.</p>
        </div>`;
      return;
    }

    let queueHtml = bucketsToRender
      .map((bucket) => {
        const isCollapsed = state.collapsedBuckets && state.collapsedBuckets.has(bucket.id);
        return `
          <section class="queue-bucket ${isCollapsed ? 'is-collapsed' : ''}" data-bucket="${bucket.id}">
            <div class="queue-bucket-header" data-toggle-bucket="${bucket.id}" role="button" tabindex="0" aria-expanded="${!isCollapsed}">
              <div class="flex items-center gap-2.5">
                <span class="queue-bucket-chevron">▾</span>
                <span class="status-dot ${bucket.dotClass}"></span>
                <h3 class="queue-bucket-title">${escapeHtml(bucket.title)}</h3>
                <span class="queue-bucket-count">${bucket.items.length}</span>
              </div>
              <span class="text-xs font-semibold secondary-copy">${escapeHtml(bucket.subtitle || '')}</span>
            </div>
            <div class="queue-bucket-content space-y-3 pt-2">
              ${
                bucket.items.length === 0
                  ? `<div class="p-4 tone-surface text-xs secondary-copy italic">${escapeHtml(bucket.emptyText)}</div>`
                  : bucket.items.map(renderTaskCard).join('')
              }
            </div>
          </section>
        `;
      })
      .join('');

    if (state.assignmentHorizon === 'all' && (completedItems.length > 0 || archivedItems.length > 0)) {
      queueHtml += `
        <div class="mt-4 p-4 tone-surface flex flex-wrap items-center justify-between gap-3 text-xs" style="border: 1px dashed var(--surface-2);">
          <span class="secondary-copy">
            <strong style="color: var(--calm);">${completedItems.length}</strong> turned in or completed in class. ${archivedItems.length > 0 ? `<span class="opacity-75">• ${archivedItems.length} past unit items archived</span>` : ''}
          </span>
          <button type="button" data-switch-horizon="completed" class="underline font-bold" style="color: var(--accent);">
            View Submitted &amp; Graded →
          </button>
        </div>
      `;
    }

    els.assignmentsList.innerHTML = queueHtml;

    els.assignmentsList.querySelectorAll('[data-toggle-bucket]').forEach((header) => {
      const bucketId = header.getAttribute('data-toggle-bucket');
      const section = header.closest('.queue-bucket');
      const toggle = () => {
        if (state.collapsedBuckets.has(bucketId)) {
          state.collapsedBuckets.delete(bucketId);
          if (section) section.classList.remove('is-collapsed');
          header.setAttribute('aria-expanded', 'true');
        } else {
          state.collapsedBuckets.add(bucketId);
          if (section) section.classList.add('is-collapsed');
          header.setAttribute('aria-expanded', 'false');
        }
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });

    els.assignmentsList.querySelectorAll('[data-toggle-done]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleAssignmentDone(btn.getAttribute('data-toggle-done'), btn);
      });
    });

    els.assignmentsList.querySelectorAll('[data-toggle-retake]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleInClassRetake(btn.getAttribute('data-toggle-retake'));
      });
    });

    els.assignmentsList.querySelectorAll('[data-switch-horizon]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const h = btn.getAttribute('data-switch-horizon');
        setAssignmentHorizon(h);
      });
    });

    if (els.assignmentsList) {
      els.assignmentsList.classList.toggle('compact-queue', Boolean(state.compactView));
    }

    els.assignmentsList.querySelectorAll('[data-copy-link]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = btn.getAttribute('data-copy-link');
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          showToast('Assignment link copied to clipboard.');
        } catch (_) {
          window.prompt('Copy this link:', url);
        }
      });
    });

    els.assignmentsList.querySelectorAll('[data-add-gcal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const aid = btn.getAttribute('data-add-gcal');
        const combined = getCombinedAssignments();
        const item = combined.find((a) => String(a.id) === String(aid));
        if (item) openGoogleCalendarEvent(item);
      });
    });

    els.assignmentsList.querySelectorAll('[data-submit-assignment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const aid = btn.getAttribute('data-submit-assignment');
        const cid = btn.getAttribute('data-course-id');
        openSubmissionModal(aid, cid);
      });
    });

    els.assignmentsList.querySelectorAll('[data-focus-task]').forEach((btn) => {
      btn.addEventListener('click', () => {
        startFocusTimer(btn.getAttribute('data-focus-task'));
      });
    });

    els.assignmentsList.querySelectorAll('[data-open-study-deck]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const deckId = btn.getAttribute('data-open-study-deck') || 'calc_log';
        openStudyLabDeck(deckId, 0);
      });
    });

    els.assignmentsList.querySelectorAll('[data-delete-custom]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-delete-custom');
        state.customTasks = state.customTasks.filter((t) => String(t.id) !== String(id));
        setStoredItem('localStorage', 'atelier_custom_tasks', JSON.stringify(state.customTasks));
        renderAll();
      });
    });
  }

  function renderAnnouncements(filteredAnnouncements) {
    const subFiltered = filteredAnnouncements
      .map(ensureAnnouncementSummarized)
      .filter((ann) => {
        if (state.announcementSearch) {
          const q = state.announcementSearch.toLowerCase();
          const textToSearch = `${ann.title || ''} ${ann.clean_text || ''} ${ann.author_name || ''} ${ann.tldr || ''} ${(ann.bullets || []).join(' ')}`.toLowerCase();
          if (!textToSearch.includes(q)) return false;
        }

        const courseId = String(ann.context_code || '').replace(/^course_/, '');
        const course = getCourseById(courseId);
        const teacherAndCourse = `${ann.author_name || ''} ${
          course ? course.name : ''
        }`.toLowerCase();

        if (state.announcementFilter === 'conder') {
          return (
            teacherAndCourse.includes('conder') ||
            teacherAndCourse.includes('world') ||
            teacherAndCourse.includes('macro')
          );
        }
        if (state.announcementFilter === 'potter') {
          return (
            teacherAndCourse.includes('potter') ||
            teacherAndCourse.includes('calc') ||
            teacherAndCourse.includes('computer science')
          );
        }
        if (state.announcementFilter === 'quiz_deadline') {
          return ann.category === 'Quiz / Test' || ann.category === 'Deadline Update';
        }
        if (state.announcementFilter === 'files') {
          return (
            (Array.isArray(ann.attachments) && ann.attachments.length > 0) ||
            ann.category === 'Study Key'
          );
        }
        return true;
      });

    if (els.annMatchCountBadge) {
      els.annMatchCountBadge.textContent = `${subFiltered.length} briefings`;
    }

    // Sort pinned briefings to the top
    subFiltered.sort((a, b) => {
      const aPinned = state.pinnedAnnouncementIds.has(String(a.id));
      const bPinned = state.pinnedAnnouncementIds.has(String(b.id));
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return 0;
    });

    if (subFiltered.length === 0) {
      els.announcementsList.innerHTML = `
        <div class="col-span-full p-8 tone-surface space-y-2 text-center">
          <p class="font-bold">No teacher briefings match your search or filter.</p>
          <p class="secondary-copy text-xs">Try clearing the search or switching teacher filter.</p>
        </div>`;
      return;
    }

    const PAGE_SIZE = 8;
    const totalPages = Math.max(1, Math.ceil(subFiltered.length / PAGE_SIZE));
    if (state.briefingPage > totalPages) state.briefingPage = totalPages;
    if (state.briefingPage < 1) state.briefingPage = 1;

    const pageItems = subFiltered.slice((state.briefingPage - 1) * PAGE_SIZE, state.briefingPage * PAGE_SIZE);

    els.announcementsList.innerHTML = pageItems
      .map((ann) => {
        const courseId = String(ann.context_code || '').replace(/^course_/, '');
        const course = getCourseById(courseId);
        const meta = course
          ? parseCourseMeta(course)
          : { period: '', title: 'Class', teacher: '' };
        const isSaved = state.savedBriefingIds.has(String(ann.id));
        const isExpanded = state.expandedAnnouncementIds.has(String(ann.id));

        const bulletsHtml =
          Array.isArray(ann.bullets) && ann.bullets.length > 0
            ? `<div class="p-3.5 tone-surface-2 space-y-1.5">
                <p class="text-[11px] font-bold" style="color: var(--ink-secondary);">
                  ${ann.is_long ? 'Summary' : 'Key point'}
                </p>
                <ul class="list-disc list-inside space-y-1 text-xs">
                  ${ann.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}
                </ul>
              </div>`
            : `<p class="secondary-copy text-xs">${escapeHtml(ann.tldr)}</p>`;

        const fullTextHtml = isExpanded
          ? `<div class="p-3.5 tone-surface-2 text-xs secondary-copy whitespace-pre-line leading-relaxed">${escapeHtml(
              ann.clean_text
            )}</div>`
          : '';

        const filesHtml =
          Array.isArray(ann.attachments) && ann.attachments.length > 0
            ? `<div class="flex flex-wrap gap-1.5 pt-1">
                ${ann.attachments
                  .map(
                    (f) =>
                      `<a href="${escapeHtml(
                        safeHttpUrl(f.url) || '#'
                      )}" target="_blank" rel="noopener noreferrer" class="context-tag hover:underline" style="color: var(--accent);">${escapeHtml(
                        f.display_name
                      )}</a>`
                  )
                  .join('')}
              </div>`
            : '';

        return `
          <article class="p-5 tone-surface flex flex-col justify-between space-y-3">
            <div class="space-y-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-xs font-bold" style="color: var(--ink-secondary);">
                  ${escapeHtml(
                    meta.period !== 'Class' ? `${meta.period} • ${meta.title}` : meta.title
                  )} • ${escapeHtml(ann.author_name)}
                </span>
                <span class="context-tag ${
                  ann.category === 'Quiz / Test' || ann.category === 'Deadline Update'
                    ? 'context-tag-accent'
                    : ''
                }">
                  ${escapeHtml(ann.category)}
                </span>
              </div>

              <h3 class="text-base font-bold leading-snug">
                <a
                  href="${escapeHtml(                  safeHttpUrl(ann.html_url || state.canvasBaseUrl) || '#')}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hover:underline"
                >
                  ${escapeHtml(ann.title)}
                </a>
              </h3>

              ${bulletsHtml}
              ${fullTextHtml}
              ${filesHtml}
            </div>

            <div class="pt-3 flex flex-wrap items-center justify-between gap-2 text-xs" style="border-top: 1px solid var(--surface-2);">
              <span class="tabular" style="color: var(--ink-secondary);">
                ${escapeHtml(formatDateTime(ann.posted_at))}
              </span>
              <div class="flex items-center gap-3 font-bold">
                ${
                  ann.is_long
                    ? `<button type="button" data-toggle-expand-ann="${escapeHtml(
                        ann.id
                      )}" class="underline" style="color: var(--ink-secondary);">
                        ${isExpanded ? 'Hide full post' : 'Full post'}
                      </button>`
                    : ''
                }
                <button
                  type="button"
                  data-save-briefing="${escapeHtml(ann.id)}"
                  class="underline"
                  style="color: ${isSaved ? 'var(--calm)' : 'var(--ink)'};"
                >
                  ${isSaved ? 'Saved' : 'Save'}
                </button>
                <a
                  href="${escapeHtml(safeHttpUrl(ann.html_url || state.canvasBaseUrl) || '#')}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline"
                  style="color: var(--accent);"
                >
                  Canvas
                </a>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    els.announcementsList.querySelectorAll('[data-pin-ann]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-pin-ann'));
        if (state.pinnedAnnouncementIds.has(id)) {
          state.pinnedAnnouncementIds.delete(id);
          showToast('Unpinned announcement.');
        } else {
          state.pinnedAnnouncementIds.add(id);
          showToast('Pinned announcement to top.');
        }
        setStoredItem('localStorage', 'slated_pinned_announcements', JSON.stringify(Array.from(state.pinnedAnnouncementIds)));
        renderAll();
      });
    });

    els.announcementsList.querySelectorAll('[data-save-briefing]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleSaveBriefing(btn.getAttribute('data-save-briefing'));
      });
    });

    els.announcementsList.querySelectorAll('[data-toggle-expand-ann]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-toggle-expand-ann'));
        if (state.expandedAnnouncementIds.has(id)) {
          state.expandedAnnouncementIds.delete(id);
        } else {
          state.expandedAnnouncementIds.add(id);
        }
        renderAll();
      });
    });

    if (els.annPaginationBar) {
      if (totalPages <= 1) {
        els.annPaginationBar.innerHTML = `<span class="page-info text-xs secondary-copy">Showing ${subFiltered.length} briefings</span>`;
      } else {
        els.annPaginationBar.innerHTML = `
          <div class="flex items-center justify-between w-full">
            <button type="button" class="page-btn" id="annPrevPageBtn" ${state.briefingPage <= 1 ? 'disabled style="opacity:0.4; pointer-events:none;"' : ''}>← Prev</button>
            <span class="page-info text-xs font-semibold secondary-copy">Page ${state.briefingPage} of ${totalPages} (${subFiltered.length} total)</span>
            <button type="button" class="page-btn" id="annNextPageBtn" ${state.briefingPage >= totalPages ? 'disabled style="opacity:0.4; pointer-events:none;"' : ''}>Next →</button>
          </div>
        `;
        const prev = els.annPaginationBar.querySelector('#annPrevPageBtn');
        const next = els.annPaginationBar.querySelector('#annNextPageBtn');
        if (prev) prev.addEventListener('click', () => { state.briefingPage--; renderAnnouncements(filteredAnnouncements); });
        if (next) next.addEventListener('click', () => { state.briefingPage++; renderAnnouncements(filteredAnnouncements); });
      }
    }
  }

  function renderCalendar(baseFilteredAssignments) {
    const year = state.calendarDate.getFullYear();
    const month = state.calendarDate.getMonth();

    els.calendarMonthLabel.textContent = new Date(year, month, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });

    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const byDay = new Map();
    for (const a of baseFilteredAssignments) {
      const dueIso = a.effective_due_at || a.due_at;
      if (!dueIso) continue;
      const d = new Date(dueIso);
      if (Number.isNaN(d.getTime())) continue;
      if (d.getFullYear() === year && d.getMonth() === month) {
        const dayNum = d.getDate();
        if (!byDay.has(dayNum)) byDay.set(dayNum, []);
        byDay.get(dayNum).push(a);
      }
    }

    const cells = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      cells.push('<div class="calendar-cell-empty"></div>');
    }

    const today = new Date();
    for (let day = 1; day <= daysInMonth; day++) {
      const isToday =
        today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
      const dayEvents = byDay.get(day) || [];

      const pillsHtml = dayEvents
        .slice(0, 3)
        .map((ev) => {
          const u = getUrgencyInfo(ev);
          return `
            <a
              href="${escapeHtml(safeHttpUrl(ev.html_url || '#deadlinesSection') || '#deadlinesSection')}"
              ${ev.html_url ? 'target="_blank" rel="noopener noreferrer"' : ''}
              title="${escapeHtml(ev.name)}"
              class="block truncate px-1.5 py-0.5 text-[11px] font-semibold ${u.chipClass} hover:opacity-85"
            >
              ${escapeHtml(ev.name)}
            </a>
          `;
        })
        .join('');

      const moreHtml =
        dayEvents.length > 3
          ? `<span class="block text-[10px] tabular" style="color: var(--ink-secondary);">+${
              dayEvents.length - 3
            } more</span>`
          : '';

      const schoolDay = getSchoolDayType(new Date(year, month, day));
      const dayBadgeHtml = schoolDay
        ? `<span class="px-1.5 py-0.2 text-[10px] font-bold" style="background: var(--surface-2); color: var(--ink); border-radius: 2px;">${schoolDay}-Day</span>`
        : '';

      cells.push(`
        <div class="calendar-cell ${isToday ? 'calendar-cell-today' : ''}">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-bold tabular">${day}</span>
              ${dayBadgeHtml}
            </div>
            ${
              isToday
                ? '<span class="text-[10px] font-bold" style="color: var(--accent);">Today</span>'
                : ''
            }
          </div>
          <div class="mt-2 space-y-1 overflow-hidden">
            ${pillsHtml}
            ${moreHtml}
          </div>
        </div>
      `);
    }

    els.calendarGrid.innerHTML = cells.join('');
  }

  // -------------------------------------------------------------------------
  // 10.5. Interactive Study & Symbolic Answer Equivalence Verifier Lab
  // -------------------------------------------------------------------------
  const STUDY_LAB_DECKS = {
    calc_log: {
      id: 'calc_log',
      title: 'AP Calculus AB · Logarithmic Differentiation',
      shortTitle: 'Calc AB · Log Differentiation (5)',
      subtitle: 'Potter · 5-problem handout + key',
      problems: [
        {
          id: 'log_1',
          number: '#1',
          prompt: 'Find dy/dx using logarithmic differentiation:  y = (x^2 + 1)^sin(x)',
          origYExpr: '(x^2 + 1)^sin(x)',
          targetExpr: '(x^2 + 1)^sin(x) * (cos(x)*ln(x^2 + 1) + (2*x*sin(x))/(x^2 + 1))',
          canonicalDisplay: "y' = (x² + 1)^sin(x) · [ cos(x) ln(x² + 1) + (2x sin(x)) / (x² + 1) ]",
          equivalentExamples: [
            '(x^2+1)^sin(x)*(cos(x)*ln(x^2+1) + 2x*sin(x)/(x^2+1))',
            'y * (cos(x)*ln(x^2+1) + (2x*sin(x))/(x^2+1))',
            '(x^2+1)^(sin(x)-1) * ((x^2+1)*cos(x)*ln(x^2+1) + 2x*sin(x))',
          ],
          steps: [
            '1. Take natural log of both sides: ln(y) = sin(x) · ln(x² + 1)',
            '2. Differentiate implicitly with respect to x (Product Rule + Chain Rule): (1/y) y\' = cos(x)·ln(x² + 1) + sin(x)·(2x / (x² + 1))',
            '3. Multiply both sides by y = (x² + 1)^sin(x): y\' = (x² + 1)^sin(x) [ cos(x) ln(x² + 1) + (2x sin(x))/(x² + 1) ]',
          ],
        },
        {
          id: 'log_2',
          number: '#2',
          prompt: 'Find dy/dx for y = x^sin(x)  (or enter the numerical slope at x = π)',
          origYExpr: 'x^sin(x)',
          targetExpr: 'x^sin(x) * (cos(x)*ln(x) + sin(x)/x)',
          altConstantExpr: '-ln(pi)',
          canonicalDisplay: "y' = x^sin(x) · [ cos(x) ln(x) + sin(x)/x ]   |   Slope at x = π is −ln(π) ≈ −1.1447",
          equivalentExamples: [
            'x^sin(x)*(cos(x)*ln(x) + sin(x)/x)',
            'x^sin(x)*(ln(x)*cos(x) + x^(-1)*sin(x))',
            '-ln(pi)',
            '-1.1447',
          ],
          steps: [
            '1. Take ln of both sides: ln(y) = sin(x) · ln(x)',
            '2. Differentiate: y\'/y = cos(x) ln(x) + sin(x)/x  ⇒  y\' = x^sin(x) [ cos(x) ln(x) + sin(x)/x ]',
            '3. Evaluate at x = π: y\'(π) = π^sin(π) [ cos(π) ln(π) + sin(π)/π ] = 1 · [ (-1)ln(π) + 0 ] = -ln(π) ≈ -1.1447',
          ],
        },
        {
          id: 'log_3',
          number: '#3',
          prompt: 'Find dy/dx using logarithmic properties:  y = ((x + 1)^3 * sqrt(x^2 + 4)) / (x^2 + 1)^2',
          origYExpr: '((x + 1)^3 * sqrt(x^2 + 4)) / (x^2 + 1)^2',
          targetExpr: '(((x + 1)^3 * sqrt(x^2 + 4)) / (x^2 + 1)^2) * (3/(x + 1) + x/(x^2 + 4) - (4*x)/(x^2 + 1))',
          canonicalDisplay: "y' = [ (x+1)³√(x²+4) / (x²+1)² ] · [ 3/(x+1) + x/(x²+4) − 4x/(x²+1) ]",
          equivalentExamples: [
            'y * (3/(x+1) + x/(x^2+4) - 4x/(x^2+1))',
            '((x+1)^3*sqrt(x^2+4)/(x^2+1)^2)*(3/(x+1) + x/(x^2+4) - 4x/(x^2+1))',
          ],
          steps: [
            '1. Expand using log laws: ln(y) = 3 ln(x + 1) + (1/2) ln(x² + 4) − 2 ln(x² + 1)',
            '2. Differentiate term-by-term: y\'/y = 3/(x + 1) + (1/2)(2x)/(x² + 4) − 2(2x)/(x² + 1)',
            '3. Multiply by y: y\' = [ (x+1)³√(x²+4) / (x²+1)² ] · [ 3/(x+1) + x/(x²+4) − 4x/(x²+1) ]',
          ],
        },
        {
          id: 'log_4',
          number: '#4',
          prompt: 'Find dy/dx for y = (sin(x))^x  (on sin(x) > 0)',
          origYExpr: '(sin(x))^x',
          targetExpr: '(sin(x))^x * (ln(sin(x)) + x * (cos(x)/sin(x)))',
          canonicalDisplay: "y' = (sin x)^x · [ ln(sin x) + x cot(x) ]",
          equivalentExamples: [
            '(sin(x))^x * (ln(sin(x)) + x*cot(x))',
            '(sin(x))^x * (ln(sin(x)) + x*cos(x)/sin(x))',
            'y * (ln(sin(x)) + x*cot(x))',
          ],
          steps: [
            '1. Take natural log: ln(y) = x · ln(sin x)',
            '2. Product rule + chain rule: y\'/y = 1·ln(sin x) + x·(cos x / sin x) = ln(sin x) + x cot(x)',
            '3. Multiply by y: y\' = (sin x)^x [ ln(sin x) + x cot(x) ]',
          ],
        },
        {
          id: 'log_5',
          number: '#5',
          prompt: 'Find y\' or tangent line at x = 0: Worksheet says y = (x^2+1)^arctan(x), Mr. Potter’s Key solved y = (x^2+2)^arctan(x)',
          origYExpr: '(x^2 + 2)^arctan(x)',
          targetExpr: '(x^2 + 2)^arctan(x) * (ln(x^2 + 2)/(1 + x^2) + (2*x*arctan(x))/(x^2 + 2))',
          altWorksheetExpr: '(x^2 + 1)^arctan(x) * (ln(x^2 + 1)/(1 + x^2) + (2*x*arctan(x))/(x^2 + 1))',
          altTangentLineKey: '(ln(2))*x + 1',
          canonicalDisplay: "Key Form (x²+2): y' = (x²+2)^arctan(x) [ ln(x²+2)/(1+x²) + 2x arctan(x)/(x²+2) ]  |  Worksheet Form (x²+1): y'(0) = 0 ⇒ y = 1",
          teacherAlert: 'The worksheet prints y = (x²+1)^arctan(x) (tangent at x=0: y = 1), but the key solves y = (x²+2)^arctan(x). Answers for either version are accepted.',
          equivalentExamples: [
            '(x^2+2)^arctan(x)*(ln(x^2+2)/(1+x^2) + 2x*arctan(x)/(x^2+2))',
            '(x^2+1)^arctan(x)*(ln(x^2+1)/(1+x^2) + 2x*arctan(x)/(x^2+1))',
            '(ln(2)/2)*x + 1',
          ],
          steps: [
            '1. If using Worksheet y = (x²+1)^arctan(x): ln(y) = arctan(x) ln(x²+1) ⇒ y\' = (x²+1)^arctan(x) [ ln(x²+1)/(1+x²) + 2x arctan(x)/(x²+1) ]. At x=0, y(0)=1 and y\'(0)=0, so tangent line is y = 1.',
            '2. If using Mr. Potter’s Key y = (x²+2)^arctan(x): ln(y) = arctan(x) ln(x²+2) ⇒ y\' = (x²+2)^arctan(x) [ ln(x²+2)/(1+x²) + 2x arctan(x)/(x²+2) ].',
          ],
        },
      ],
    },

    calc_implicit: {
      id: 'calc_implicit',
      title: 'AP Calculus AB · Implicit Differentiation',
      shortTitle: 'Calc AB · Implicit Differentiation',
      subtitle: 'Potter · 20-problem set + key',
      problems: [
        {
          id: 'imp_1',
          number: '#1',
          prompt: 'Find dy/dx by implicit differentiation:  x^2 + x*y + y^2 = 19',
          targetExpr: '(-2*x - y) / (x + 2*y)',
          canonicalDisplay: "dy/dx = (−2x − y) / (x + 2y)   ≡   −(2x + y) / (2y + x)",
          equivalentExamples: [
            '(-2x - y)/(x + 2y)',
            '-(2x + y)/(2y + x)',
            '(-y - 2x)/(2y + x)',
          ],
          steps: [
            '1. Differentiate both sides w.r.t. x (use Product Rule on xy): 2x + (1·y + x·y\') + 2y·y\' = 0',
            '2. Group y\' terms: y\'(x + 2y) = −2x − y',
            '3. Divide: dy/dx = (−2x − y) / (x + 2y)',
          ],
        },
        {
          id: 'imp_2',
          number: '#2',
          prompt: 'Find dy/dx by implicit differentiation:  x^3*y + x*y^3 = 10',
          targetExpr: '(-3*x^2*y - y^3) / (x^3 + 3*x*y^2)',
          canonicalDisplay: "dy/dx = (−3x²y − y³) / (x³ + 3xy²)   ≡   −y(3x² + y²) / [x(x² + 3y²)]",
          equivalentExamples: [
            '(-3x^2*y - y^3)/(x^3 + 3x*y^2)',
            '-y*(3x^2 + y^2)/(x*(x^2 + 3y^2))',
          ],
          steps: [
            '1. Product rule on both terms: (3x²y + x³y\') + (y³ + 3xy²y\') = 0',
            '2. Factor y\': y\'(x³ + 3xy²) = −3x²y − y³',
            '3. Solve for y\': dy/dx = (−3x²y − y³) / (x³ + 3xy²)',
          ],
        },
        {
          id: 'imp_3',
          number: '#3',
          prompt: 'Find dy/dx (quotient or cleared-denominator form both accepted!):  x^2/y + y^2/x = 6',
          targetExpr: '(y*(2*x^3 - y^3)) / (x*(x^3 - 2*y^3))',
          canonicalDisplay: "dy/dx = y(2x³ − y³) / [ x(x³ − 2y³) ]   ≡   (2x/y − y²/x²) / (x²/y² − 2y/x)",
          equivalentExamples: [
            'y*(2x^3 - y^3)/(x*(x^3 - 2y^3))',
            '(2*x/y - y^2/x^2)/(x^2/y^2 - 2*y/x)',
            '(2x^3*y - y^4)/(x^4 - 2x*y^3)',
          ],
          steps: [
            '1. Differentiate x²y⁻¹ + x⁻¹y² = 6:  (2x/y − (x²/y²)y\') + (−y²/x² + (2y/x)y\') = 0',
            '2. Unsimplified quotient form: y\' = (y²/x² − 2x/y) / (2y/x − x²/y²)',
            '3. Multiply numerator & denominator by x²y²: dy/dx = y(2x³ − y³) / [ x(x³ − 2y³) ]  (Both forms verify as 100% equivalent!)',
          ],
        },
        {
          id: 'imp_4',
          number: '#4',
          prompt: 'Find dy/dx:  sin(x*y) + cos(y) = x',
          targetExpr: '(1 - y*cos(x*y)) / (x*cos(x*y) - sin(y))',
          canonicalDisplay: "dy/dx = (1 − y cos(xy)) / (x cos(xy) − sin(y))",
          equivalentExamples: [
            '(1 - y*cos(x*y))/(x*cos(x*y) - sin(y))',
            '(y*cos(x*y) - 1)/(sin(y) - x*cos(x*y))',
          ],
          steps: [
            '1. Chain rule + product rule on sin(xy): cos(xy)·(y + x y\') − sin(y)·y\' = 1',
            '2. Expand: y cos(xy) + x cos(xy) y\' − sin(y) y\' = 1',
            '3. Solve for y\': dy/dx = (1 − y cos(xy)) / (x cos(xy) − sin(y))',
          ],
        },
        {
          id: 'imp_5',
          number: '#5',
          prompt: 'Find dy/dx:  x*sec(y) + y*csc(x) = 4',
          targetExpr: '(y*csc(x)*cot(x) - sec(y)) / (x*sec(y)*tan(y) + csc(x))',
          canonicalDisplay: "dy/dx = (y csc(x) cot(x) − sec(y)) / (x sec(y) tan(y) + csc(x))",
          equivalentExamples: [
            '(y*csc(x)*cot(x) - sec(y))/(x*sec(y)*tan(y) + csc(x))',
            '(sec(y) - y*csc(x)*cot(x))/(-x*sec(y)*tan(y) - csc(x))',
          ],
          steps: [
            '1. Differentiate: sec(y) + x sec(y)tan(y) y\' + y\' csc(x) − y csc(x)cot(x) = 0',
            '2. Collect y\': y\'(x sec(y)tan(y) + csc(x)) = y csc(x)cot(x) − sec(y)',
            '3. Divide: dy/dx = (y csc(x) cot(x) − sec(y)) / (x sec(y) tan(y) + csc(x))',
          ],
        },
        {
          id: 'imp_8',
          number: '#8',
          prompt: 'Find dy/dx:  ln(x^2 + y^2) = x*y',
          targetExpr: '(2*x - y*(x^2 + y^2)) / (x*(x^2 + y^2) - 2*y)',
          canonicalDisplay: "dy/dx = [ 2x − y(x² + y²) ] / [ x(x² + y²) − 2y ]   ≡   [ 2x/(x²+y²) − y ] / [ x − 2y/(x²+y²) ]",
          equivalentExamples: [
            '(2x - y*(x^2+y^2))/(x*(x^2+y^2) - 2y)',
            '(2x/(x^2+y^2) - y)/(x - 2y/(x^2+y^2))',
          ],
          steps: [
            '1. Differentiate both sides: (2x + 2y·y\') / (x² + y²) = y + x·y\'',
            '2. Multiply by (x² + y²): 2x + 2y·y\' = y(x² + y²) + x(x² + y²)y\'',
            '3. Solve for y\': dy/dx = [ 2x − y(x² + y²) ] / [ x(x² + y²) − 2y ]',
          ],
        },
        {
          id: 'imp_13',
          number: '#13 (Tangent Line)',
          prompt: 'Find the equation of the tangent line to x^2 + x*y + y^2 = 7 at (1, 2)',
          targetExpr: '-0.8*(x - 1) + 2',
          isTangentLine: true,
          canonicalDisplay: "y − 2 = −(4/5)(x − 1)   ≡   y = −0.8x + 2.8   ≡   4x + 5y = 14",
          equivalentExamples: [
            'y - 2 = -4/5*(x - 1)',
            'y = -4/5*x + 14/5',
            '-0.8*x + 2.8',
          ],
          steps: [
            '1. Differentiate x² + xy + y² = 7:  y\' = (−2x − y) / (x + 2y)',
            '2. Plug in (1, 2): y\'(1, 2) = (−2(1) − 2) / (1 + 2(2)) = −4/5 = −0.8',
            '3. Point-slope form: y − 2 = −(4/5)(x − 1)  or  y = −0.8x + 2.8',
          ],
        },
        {
          id: 'imp_17',
          number: '#17 (2nd Derivative)',
          prompt: 'Find the second derivative d²y/dx² for x^2 + y^2 = 25',
          targetExpr: '-25 / y^3',
          altCurveExpr: '-(x^2 + y^2) / y^3',
          canonicalDisplay: "y'' = −25 / y³   ≡   −(x² + y²) / y³",
          equivalentExamples: [
            '-25/y^3',
            '-(x^2 + y^2)/y^3',
            '(-y - x*(-x/y))/y^2',
          ],
          steps: [
            '1. First derivative: 2x + 2y·y\' = 0  ⇒  y\' = −x / y',
            '2. Quotient rule for y\'\': y\'\' = ( (−1)(y) − (−x)(y\') ) / y² = ( −y + x(−x/y) ) / y² = −(x² + y²) / y³',
            '3. Substitute x² + y² = 25:  y\'\' = −25 / y³  (Both −(x²+y²)/y³ and −25/y³ are accepted!)',
          ],
        },
      ],
    },

    macro_mult: {
      id: 'macro_mult',
      title: 'AP Macroeconomics · Multipliers & AD/AS',
      shortTitle: 'Macro · Multipliers & AD/AS',
      subtitle: 'Conder · Unit 3 homework + Krugman Modules 16–19',
      problems: [
        {
          id: 'mac_1',
          number: 'PDF #1',
          prompt: 'Increased Government Spending (ΔG) of $1,000 with MPC = 0.5. Find max ΔGDP (or enter formula):',
          targetExpr: '2000',
          canonicalDisplay: "Spending Multiplier = 1/(1 − 0.5) = 2   ⇒   Max ΔGDP = +$2,000",
          equivalentExamples: ['2000', '1000 * (1 / (1 - 0.5))', '1000 * 2'],
          steps: [
            '1. Spending Multiplier = 1 / (1 − MPC) = 1 / (1 − 0.5) = 2',
            '2. Max ΔGDP = ΔG × Multiplier = $1,000 × 2 = +$2,000',
          ],
        },
        {
          id: 'mac_2',
          number: 'PDF #2',
          prompt: 'Increased Taxes (ΔT = +$1,000) with MPC = 0.8. Find max ΔGDP (include negative sign for contraction):',
          targetExpr: '-4000',
          canonicalDisplay: "Tax Multiplier = −MPC/(1 − MPC) = −0.8/0.2 = −4   ⇒   Max ΔGDP = −$4,000",
          equivalentExamples: ['-4000', '1000 * (-0.8 / (1 - 0.8))', '-4 * 1000'],
          steps: [
            '1. Tax Multiplier = −MPC / MPS = −0.8 / (1 − 0.8) = −4',
            '2. Max ΔGDP = ΔT × Tax Multiplier = +$1,000 × (−4) = −$4,000',
          ],
        },
        {
          id: 'mac_3',
          number: 'PDF #3',
          prompt: 'Decreased Taxes (ΔT = −$2,000 tax cut) with MPC = 0.75. Find max ΔGDP:',
          targetExpr: '6000',
          canonicalDisplay: "Tax Multiplier = −0.75/0.25 = −3   ⇒   Max ΔGDP = (−$2,000) × (−3) = +$6,000",
          equivalentExamples: ['6000', '-2000 * (-0.75 / 0.25)', '2000 * 3'],
          steps: [
            '1. Tax Multiplier = −MPC / (1 − MPC) = −0.75 / 0.25 = −3',
            '2. Max ΔGDP = (−$2,000) × (−3) = +$6,000',
          ],
        },
        {
          id: 'mac_4',
          number: 'PDF #4',
          prompt: 'Increased Investment (ΔI = +$5,000) with MPC = 0.9. Find max ΔGDP:',
          targetExpr: '50000',
          canonicalDisplay: "Spending Multiplier = 1/(1 − 0.9) = 10   ⇒   Max ΔGDP = +$50,000",
          equivalentExamples: ['50000', '5000 * (1 / (1 - 0.9))', '5000 * 10'],
          steps: [
            '1. Spending Multiplier = 1 / (1 − 0.9) = 10',
            '2. Max ΔGDP = $5,000 × 10 = +$50,000',
          ],
        },
        {
          id: 'mac_5',
          number: 'Balanced Budget (#5)',
          prompt: 'Government increases spending by $5B (ΔG = +5) and increases taxes by $5B (ΔT = +5). Find net ΔGDP (in billions):',
          targetExpr: '5',
          canonicalDisplay: "Balanced Budget Multiplier = 1   ⇒   Net ΔGDP = +$5 billion (regardless of MPC!)",
          equivalentExamples: ['5', '5 * 1'],
          steps: [
            '1. Spending Multiplier = 1/(1−MPC); Tax Multiplier = −MPC/(1−MPC)',
            '2. Sum = (1 − MPC)/(1 − MPC) = 1 (Balanced Budget Multiplier is always 1)',
            '3. Net ΔGDP = $5 billion × 1 = +$5 billion',
          ],
        },
        {
          id: 'mac_6',
          number: 'Krugman Mod 16 FRQ',
          prompt: 'Given consumption function c = 15000 + 0.8*x (where x is disposable income $40,000), find consumer spending c:',
          targetExpr: '47000',
          canonicalDisplay: "c = $15,000 + 0.8($40,000) = $15,000 + $32,000 = $47,000",
          equivalentExamples: ['47000', '15000 + 0.8*40000'],
          steps: [
            '1. Autonomous consumption a = $15,000; MPC = 0.8',
            '2. Induced consumption = 0.8 × $40,000 = $32,000',
            '3. Total spending c = $15,000 + $32,000 = $47,000',
          ],
        },
      ],
    },

    world_pbl: {
      id: 'world_pbl',
      title: 'AP World History · Columbian Exchange Menu Check',
      shortTitle: 'World · Columbian Exchange PBL',
      subtitle: 'Conder · Food Truck PBL — classify dishes as Old World, New World, or Mixed',
      isIngredientVerifier: true,
      problems: [
        {
          id: 'pbl_checker',
          number: '3×3 Menu Rule',
          prompt: 'Enter the ingredients in your dish & sides (comma-separated) to verify if it qualifies as Old World Only, New World Only, or Mixed (Both Worlds):',
          canonicalDisplay: 'Rule from Food_Truck_PBL.pdf: Cacao, vanilla, tomato, potato, corn/maize, chili pepper, avocado, peanut, turkey, squash, beans, pineapple are NEW WORLD (Americas). Wheat, rice, beef, pork, chicken, milk, cheese, butter, sugar, coffee, onion, garlic, olive oil, black pepper, cinnamon, citrus are OLD WORLD (Afro-Eurasia). Salt & water are neutral.',
          equivalentExamples: [
            'corn, black beans, tomato, avocado, chili pepper, turkey, salt',
            'wheat, beef, onion, garlic, olive oil, cheese, black pepper',
            'cacao, milk, sugar, vanilla',
          ],
          steps: [
            'OLD WORLD ONLY = Every plant/animal ingredient in the dish (and its 2 sides, if an entrée) came from Afro-Eurasia.',
            'NEW WORLD ONLY = Every food ingredient came from the Americas (watch out: adding cheese, butter, wheat tortilla, beef, or cane sugar makes it MIXED!).',
            'MIXED: BOTH WORLDS = At least one ingredient from Afro-Eurasia AND at least one from the Americas.',
          ],
        },
      ],
    },

    custom_math: {
      id: 'custom_math',
      title: 'Any Expression',
      shortTitle: 'Custom · Compare any two expressions',
      subtitle: 'Paste a key and your answer; checked numerically at 12 points',
      isCustomSandbox: true,
      problems: [
        {
          id: 'custom_1',
          number: 'Sandbox',
          prompt: 'Enter any target expression (key) and your candidate answer to verify if they are mathematically equivalent:',
          targetExpr: '(x^2 + 1)^sin(x) * (cos(x)*ln(x^2 + 1) + (2*x*sin(x))/(x^2 + 1))',
          origYExpr: '(x^2 + 1)^sin(x)',
          canonicalDisplay: 'Tests 12 non-singular points in (x, y) to prove algebraic & trigonometric equivalence.',
          equivalentExamples: [
            '(x^2+1)^sin(x)*(cos(x)*ln(x^2+1) + 2x*sin(x)/(x^2+1))',
          ],
          steps: [
            'Supports x, y, pi, e, sin, cos, tan, cot, sec, csc, arcsin, arccos, arctan, ln, log, sqrt, and exponents (^).',
          ],
        },
      ],
    },
  };

  // Normalize human/LaTeX math notation into a safe JS mathematical expression
  function normalizeMathExpr(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';

    // Strip leading "y' =", "dy/dx =", "f'(x) =", "c ="
    if (/^(?:y''|y'|dy\s*\/\s*dx|d\^2y\s*\/\s*dx\^2|f'\(x\)|slope|c|gdp)\s*=/i.test(s)) {
      s = s.replace(/^(?:y''|y'|dy\s*\/\s*dx|d\^2y\s*\/\s*dx\^2|f'\(x\)|slope|c|gdp)\s*=\s*/i, '');
    }

    // Handle tangent line equations like "y - 2 = -4/5(x - 1)" or "4x + 5y = 14"
    if (s.includes('=')) {
      const parts = s.split('=');
      if (parts.length === 2) {
        const lhs = parts[0].trim();
        const rhs = parts[1].trim();
        if (/^y$/i.test(lhs)) {
          s = rhs;
        } else {
          const yMinusMatch = lhs.match(/^y\s*([+-]\s*[\d.]+)$/i);
          if (yMinusMatch) {
            const offset = yMinusMatch[1].replace(/\s+/g, '');
            const invertedOffset = offset.startsWith('-')
              ? `+ (${offset.slice(1)})`
              : `- (${offset.slice(1)})`;
            s = `(${rhs}) ${invertedOffset}`;
          }
        }
      }
    }

    // Remove dollar signs & commas in numbers (e.g. "$47,000" -> "47000")
    s = s.replace(/\$/g, '').replace(/(\d),(\d{3})\b/g, '$1$2');

    // Convert Unicode math symbols & superscripts
    s = s
      .replace(/[−–—]/g, '-')
      .replace(/[×·•]/g, '*')
      .replace(/÷/g, '/')
      .replace(/π/g, 'pi')
      .replace(/√\s*\(/g, 'sqrt(')
      .replace(/√\s*([a-zA-Z0-9]+)/g, 'sqrt($1)')
      .replace(/²/g, '^2')
      .replace(/³/g, '^3')
      .replace(/⁴/g, '^4')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/\{/g, '(')
      .replace(/\}/g, ')');

    // Basic LaTeX conversions if user pasted LaTeX
    s = s
      .replace(/\\frac\s*\(([^()]+)\)\s*\(([^()]+)\)/g, '(($1)/($2))')
      .replace(/\\(?:ln|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sqrt|pi)\b/g, (m) => m.slice(1))
      .replace(/\\left|\\right/g, '');

    // Handle trig powers like sin^2(x), csc^2(xy) -> (sin(x))^2
    s = s.replace(/\b(sin|cos|tan|cot|sec|csc)\s*\^\s*(\d+)\s*\(([^()]+)\)/gi, '(($1($3))^$2)');

    // Replace function names with placeholders before implicit multiplication
    const fnMap = {
      arcsin: '__ASIN__',
      arccos: '__ACOS__',
      arctan: '__ATAN__',
      'sin^-1': '__ASIN__',
      'cos^-1': '__ACOS__',
      'tan^-1': '__ATAN__',
      sinh: '__SINH__',
      cosh: '__COSH__',
      tanh: '__TANH__',
      sin: '__SIN__',
      cos: '__COS__',
      tan: '__TAN__',
      cot: '__COT__',
      sec: '__SEC__',
      csc: '__CSC__',
      sqrt: '__SQRT__',
      ln: '__LN__',
      log: '__LOG10__',
      exp: '__EXP__',
      abs: '__ABS__',
      pi: '__PI__',
    };

    const sortedKeys = Object.keys(fnMap).sort((a, b) => b.length - a.length);
    for (const k of sortedKeys) {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(escaped, 'gi'), fnMap[k]);
    }

    // Insert implicit multiplication:
    // 1. number followed by variable, constant, placeholder, or '('  e.g. 2x, 3(x+1), 2__SIN__
    s = s.replace(/(\d)([a-zA-Z_(])/g, '$1*$2');
    // 2. ')' followed by '(', number, variable, or placeholder e.g. (x+1)(x-1), (x+1)y
    s = s.replace(/(\))([\d(a-zA-Z_])/g, '$1*$2');
    // 3. single variable x, y, e followed by '(', placeholder, or another variable (e.g. xy -> x*y, x(x+1) -> x*(x+1), x__COS__ -> x*__COS__)
    s = s.replace(/\b([xye])\s*([xye])\b/g, '$1*$2');
    s = s.replace(/\b([xye])\s*([xye])\b/g, '$1*$2');
    s = s.replace(/([xye])(\(|__)/g, '$1*$2');
    s = s.replace(/(__PI__)(\(|[xye\d]|__)/g, '$1*$2');

    // Convert '^' to '**'
    s = s.replace(/\^/g, '**');

    // Restore placeholders to safe math context functions
    const restoreMap = {
      __ASIN__: 'Math.asin',
      __ACOS__: 'Math.acos',
      __ATAN__: 'Math.atan',
      __SINH__: 'Math.sinh',
      __COSH__: 'Math.cosh',
      __TANH__: 'Math.tanh',
      __SIN__: 'Math.sin',
      __COS__: 'Math.cos',
      __TAN__: 'Math.tan',
      __COT__: '_cot',
      __SEC__: '_sec',
      __CSC__: '_csc',
      __SQRT__: 'Math.sqrt',
      __LN__: 'Math.log',
      __LOG10__: 'Math.log10',
      __EXP__: 'Math.exp',
      __ABS__: 'Math.abs',
      __PI__: 'Math.PI',
    };

    for (const [token, jsFn] of Object.entries(restoreMap)) {
      s = s.replace(new RegExp(token, 'g'), jsFn);
    }

    // Replace standalone 'e' with Math.E
    s = s.replace(/\be\b/g, 'Math.E');

    return s;
  }

  function evalMathExprAt(rawExpr, xVal, yVal) {
    const code = normalizeMathExpr(rawExpr);
    if (!code) return NaN;
    // Block any unsafe characters (only allow Math., _cot, _sec, _csc, x, y, numbers, operators, parens)
    const stripped = code
      .replace(/Math\.(asin|acos|atan|sinh|cosh|tanh|sin|cos|tan|sqrt|log10|log|exp|abs|PI|E)/g, '')
      .replace(/_(cot|sec|csc)/g, '');
    if (/[^xy0-9+\-*/.,()\s]/.test(stripped)) {
      return NaN;
    }
    try {
      const fn = new Function(
        'x',
        'y',
        '_cot',
        '_sec',
        '_csc',
        `"use strict"; return (${code});`
      );
      const val = fn(
        xVal,
        yVal,
        (t) => Math.cos(t) / Math.sin(t),
        (t) => 1 / Math.cos(t),
        (t) => 1 / Math.sin(t)
      );
      return typeof val === 'number' ? val : NaN;
    } catch (_) {
      return NaN;
    }
  }

  function verifyMathEquivalence(userRawInput, problem) {
    const cleaned = String(userRawInput || '').trim();
    if (!cleaned) {
      return {
        status: 'empty',
        headline: 'Enter an expression above to verify equivalence.',
        detail: '',
      };
    }

    // Special check for standard form tangent line "4x + 5y = 14" on Problem #13
    if (problem.isTangentLine && /4\s*\*?\s*x\s*\+\s*5\s*\*?\s*y\s*=\s*14/i.test(cleaned)) {
      return {
        status: 'equivalent',
        headline: '100% Mathematically Equivalent! (Standard Linear Form)',
        detail: 'Your standard form equation 4x + 5y = 14 is algebraically identical to Mr. Potter’s point-slope key y − 2 = −(4/5)(x − 1).',
      };
    }

    const testPoints = [
      { x: 0.37, y: 1.19 },
      { x: 0.61, y: 0.83 },
      { x: 0.89, y: 1.41 },
      { x: 1.13, y: 0.67 },
      { x: 1.31, y: 1.73 },
      { x: 0.48, y: 1.52 },
      { x: 0.74, y: 0.94 },
      { x: 1.07, y: 1.28 },
    ];

    const compareAgainstTarget = (targetExprStr) => {
      if (!targetExprStr) return null;
      let validCount = 0;
      let exactCount = 0;
      let negCount = 0;
      let recipCount = 0;
      let missingYFactorCount = 0;

      for (const pt of testPoints) {
        const x = pt.x;
        const y = problem.origYExpr ? evalMathExprAt(problem.origYExpr, x, pt.y) : pt.y;
        const targetVal = evalMathExprAt(targetExprStr, x, y);
        const userVal = evalMathExprAt(cleaned, x, y);

        if (!Number.isFinite(targetVal) || !Number.isFinite(userVal)) continue;
        validCount++;

        const scale = Math.max(1, Math.abs(targetVal));
        if (Math.abs(userVal - targetVal) / scale < 1e-4) {
          exactCount++;
        } else if (Math.abs(userVal + targetVal) / scale < 1e-4) {
          negCount++;
        } else if (Math.abs(userVal * targetVal - 1) < 1e-4) {
          recipCount++;
        } else if (
          problem.origYExpr &&
          Number.isFinite(y) &&
          Math.abs(userVal * y - targetVal) / scale < 1e-4
        ) {
          missingYFactorCount++;
        }
      }

      if (validCount >= 4 && exactCount === validCount) return { match: 'equivalent' };
      if (validCount >= 4 && missingYFactorCount === validCount) return { match: 'missing_y' };
      if (validCount >= 4 && negCount === validCount) return { match: 'sign_error' };
      if (validCount >= 4 && recipCount === validCount) return { match: 'reciprocal_error' };
      return { match: 'mismatch', validCount };
    };

    const primaryRes = compareAgainstTarget(problem.targetExpr);
    if (!primaryRes || primaryRes.validCount === 0) {
      return {
        status: 'syntax',
        headline: 'Could not parse math expression.',
        detail: 'Check for unmatched parentheses or typos. Example syntax: (x^2+1)^sin(x)*(cos(x)*ln(x^2+1) + 2x*sin(x)/(x^2+1))',
      };
    }

    const usedYVariable = /\by\b/i.test(cleaned) && Boolean(problem.origYExpr);

    if (primaryRes.match === 'equivalent') {
      return {
        status: 'equivalent',
        headline: '100% Equivalent Form Verified!',
        detail: usedYVariable
          ? `Your expression matches the exact derivative across all test points! Tip for Mr. Potter’s quiz: since you wrote "y" in your expression, remember to substitute y = ${problem.origYExpr} on your final line so your answer is written purely in terms of x.`
          : `Your answer is algebraically equivalent to the answer key (${problem.canonicalDisplay}), even if written with a different factoring, term order, or trig identity.`,
      };
    }

    // Check alternate valid forms (e.g. Problem #2 slope at x=pi, Problem #5 worksheet vs key, Problem #17 curve substitution)
    if (problem.altConstantExpr) {
      const altRes = compareAgainstTarget(problem.altConstantExpr);
      if (altRes && altRes.match === 'equivalent') {
        return {
          status: 'equivalent',
          headline: '100% Equivalent! (Exact Slope at x = π Verified)',
          detail: 'Your numerical slope at x = π matches −ln(π) ≈ −1.1447 from Mr. Potter’s key.',
        };
      }
    }

    if (problem.altWorksheetExpr) {
      const wsRes = compareAgainstTarget(problem.altWorksheetExpr);
      if (wsRes && wsRes.match === 'equivalent') {
        return {
          status: 'equivalent',
          headline: '100% Equivalent to Worksheet Problem #5: y = (x²+1)^arctan(x)!',
          detail: 'Heads-up: Your derivative is 100% accurate for the worksheet’s printed problem y = (x²+1)^arctan(x)! Note that Mr. Potter’s answer key accidentally solved y = (x²+2)^arctan(x) instead.',
        };
      }
    }

    if (problem.altTangentLineKey) {
      const tlRes = compareAgainstTarget(problem.altTangentLineKey);
      const halfLn2Res = compareAgainstTarget('(ln(2)/2)*x + 1');
      if ((tlRes && tlRes.match === 'equivalent') || (halfLn2Res && halfLn2Res.match === 'equivalent')) {
        return {
          status: 'equivalent',
          headline: 'Matches Mr. Potter’s Key Tangent Line at x = 0!',
          detail: 'Verified tangent line at (0, 1) for Problem #5.',
        };
      }
    }

    if (problem.altCurveExpr) {
      const curveRes = compareAgainstTarget(problem.altCurveExpr);
      if (curveRes && curveRes.match === 'equivalent') {
        return {
          status: 'equivalent',
          headline: '100% Equivalent! (Unsubstituted Curve Form)',
          detail: 'Your expression −(x² + y²)/y³ is completely correct! Substituting the original equation x² + y² = 25 simplifies the numerator to −25/y³.',
        };
      }
    }

    if (primaryRes.match === 'missing_y') {
      return {
        status: 'partial',
        headline: 'Almost! You found y\' / y — don’t forget to multiply by y!',
        detail: `Your expression is 100% equal to (1/y)·dy/dx! For the final step of logarithmic differentiation, multiply your entire bracket by y = ${problem.origYExpr}.`,
      };
    }

    if (primaryRes.match === 'sign_error') {
      return {
        status: 'partial',
        headline: 'Close! Off by a negative sign (−1 factor).',
        detail: 'Your magnitude and terms match the answer key, but your expression has the opposite sign. Check your signs when moving terms across the "=" sign.',
      };
    }

    if (primaryRes.match === 'reciprocal_error') {
      return {
        status: 'partial',
        headline: 'Close! Your answer is the reciprocal (dx/dy instead of dy/dx).',
        detail: 'Your numerator and denominator are flipped compared to dy/dx. Flip your fraction to get the exact key!',
      };
    }

    return {
      status: 'different',
      headline: 'Not Equivalent to the Target Key Yet',
      detail: `Evaluated across multiple (x, y) test points, your expression produces different values than ${problem.canonicalDisplay}. Open the solution key below to compare each term.`,
    };
  }

  // Columbian Exchange 3x3 Food Truck Ingredient Origin Verifier (Extracted from Food_Truck_PBL.pdf)
  const COLUMBIAN_INGREDIENTS_DB = {
    // New World (Americas)
    corn: { world: 'New World', region: 'Mesoamerica' },
    maize: { world: 'New World', region: 'Mesoamerica' },
    potato: { world: 'New World', region: 'Andes (South America)' },
    potatoes: { world: 'New World', region: 'Andes (South America)' },
    'sweet potato': { world: 'New World', region: 'Central/South America' },
    tomato: { world: 'New World', region: 'Andes / Mesoamerica' },
    tomatoes: { world: 'New World', region: 'Andes / Mesoamerica' },
    cacao: { world: 'New World', region: 'Mesoamerica / Amazonia' },
    cocoa: { world: 'New World', region: 'Mesoamerica' },
    chocolate: { world: 'New World (Warning: pure cacao is NW, but milk & cane sugar are Old World!)', region: 'Mesoamerica' },
    vanilla: { world: 'New World', region: 'Mesoamerica' },
    avocado: { world: 'New World', region: 'Mesoamerica' },
    guacamole: { world: 'New World (if made without onion/garlic/lime!)', region: 'Mesoamerica' },
    chili: { world: 'New World', region: 'Americas' },
    'chili pepper': { world: 'New World', region: 'Americas' },
    jalapeno: { world: 'New World', region: 'Mesoamerica' },
    'bell pepper': { world: 'New World', region: 'Americas' },
    peppers: { world: 'New World', region: 'Americas' },
    turkey: { world: 'New World', region: 'North/Mesoamerica' },
    squash: { world: 'New World', region: 'Mesoamerica' },
    pumpkin: { world: 'New World', region: 'North/Mesoamerica' },
    peanut: { world: 'New World', region: 'South America' },
    peanuts: { world: 'New World', region: 'South America' },
    'black beans': { world: 'New World', region: 'Americas' },
    'pinto beans': { world: 'New World', region: 'Americas' },
    'kidney beans': { world: 'New World', region: 'Americas' },
    beans: { world: 'New World', region: 'Americas' },
    pineapple: { world: 'New World', region: 'South America' },
    papaya: { world: 'New World', region: 'Mesoamerica' },
    guava: { world: 'New World', region: 'Tropical Americas' },
    cassava: { world: 'New World', region: 'South America' },
    manioc: { world: 'New World', region: 'South America' },
    quinoa: { world: 'New World', region: 'Andes' },
    chia: { world: 'New World', region: 'Mesoamerica' },
    sunflower: { world: 'New World', region: 'North America' },
    cranberry: { world: 'New World', region: 'North America' },
    blueberry: { world: 'New World', region: 'North America' },
    pecan: { world: 'New World', region: 'North America' },
    cashew: { world: 'New World', region: 'Brazil' },
    'maple syrup': { world: 'New World', region: 'North America' },
    allspice: { world: 'New World', region: 'Caribbean / Mesoamerica' },

    // Old World (Afro-Eurasia)
    wheat: { world: 'Old World', region: 'Southwest Asia (Fertile Crescent)' },
    flour: { world: 'Old World', region: 'Southwest Asia (Wheat)' },
    bread: { world: 'Old World', region: 'Afro-Eurasia' },
    rice: { world: 'Old World', region: 'East/South Asia or West Africa' },
    barley: { world: 'Old World', region: 'Southwest Asia' },
    oats: { world: 'Old World', region: 'Europe / Near East' },
    beef: { world: 'Old World', region: 'Eurasia / North Africa' },
    steak: { world: 'Old World', region: 'Eurasia' },
    cattle: { world: 'Old World', region: 'Eurasia' },
    pork: { world: 'Old World', region: 'Eurasia' },
    bacon: { world: 'Old World', region: 'Eurasia' },
    ham: { world: 'Old World', region: 'Eurasia' },
    chicken: { world: 'Old World', region: 'Southeast/South Asia' },
    eggs: { world: 'Old World', region: 'Southeast Asia (Chicken)' },
    lamb: { world: 'Old World', region: 'Southwest Asia' },
    goat: { world: 'Old World', region: 'Southwest Asia' },
    milk: { world: 'Old World', region: 'Afro-Eurasia (Dairy)' },
    cheese: { world: 'Old World', region: 'Afro-Eurasia (Dairy)' },
    butter: { world: 'Old World', region: 'Afro-Eurasia (Dairy)' },
    cream: { world: 'Old World', region: 'Afro-Eurasia (Dairy)' },
    yogurt: { world: 'Old World', region: 'Southwest/Central Asia' },
    sugar: { world: 'Old World', region: 'Southeast Asia / New Guinea (Sugarcane)' },
    'cane sugar': { world: 'Old World', region: 'Southeast Asia' },
    honey: { world: 'Old World', region: 'Afro-Eurasia (Honeybee)' },
    onion: { world: 'Old World', region: 'Central/Southwest Asia' },
    onions: { world: 'Old World', region: 'Central/Southwest Asia' },
    garlic: { world: 'Old World', region: 'Central Asia' },
    'olive oil': { world: 'Old World', region: 'Mediterranean Basin' },
    olives: { world: 'Old World', region: 'Mediterranean Basin' },
    'black pepper': { world: 'Old World', region: 'South Asia (India)' },
    cinnamon: { world: 'Old World', region: 'South Asia (Sri Lanka)' },
    ginger: { world: 'Old World', region: 'Maritime Southeast Asia' },
    nutmeg: { world: 'Old World', region: 'Banda Islands (Indonesia)' },
    cloves: { world: 'Old World', region: 'Maluku Islands (Indonesia)' },
    cumin: { world: 'Old World', region: 'Mediterranean / Southwest Asia' },
    cilantro: { world: 'Old World', region: 'Mediterranean / Southwest Asia' },
    coriander: { world: 'Old World', region: 'Mediterranean / Southwest Asia' },
    basil: { world: 'Old World', region: 'South/Southeast Asia' },
    oregano: { world: 'Old World', region: 'Mediterranean' },
    rosemary: { world: 'Old World', region: 'Mediterranean' },
    thyme: { world: 'Old World', region: 'Mediterranean' },
    parsley: { world: 'Old World', region: 'Mediterranean' },
    lemon: { world: 'Old World', region: 'South/East Asia' },
    lime: { world: 'Old World', region: 'Southeast Asia' },
    orange: { world: 'Old World', region: 'East/Southeast Asia' },
    banana: { world: 'Old World', region: 'Southeast Asia / New Guinea' },
    plantain: { world: 'Old World', region: 'Southeast Asia' },
    mango: { world: 'Old World', region: 'South Asia' },
    apple: { world: 'Old World', region: 'Central Asia' },
    Apples: { world: 'Old World', region: 'Central Asia' },
    peach: { world: 'Old World', region: 'China (East Asia)' },
    pear: { world: 'Old World', region: 'Eurasia' },
    grapes: { world: 'Old World', region: 'Near East / Mediterranean' },
    coffee: { world: 'Old World', region: 'East Africa (Ethiopia) / Yemen' },
    tea: { world: 'Old World', region: 'East Asia (China)' },
    carrot: { world: 'Old World', region: 'Central Asia (Persia)' },
    lettuce: { world: 'Old World', region: 'Mediterranean / Egypt' },
    spinach: { world: 'Old World', region: 'Persia (Southwest Asia)' },
    cabbage: { world: 'Old World', region: 'Europe' },
    cucumber: { world: 'Old World', region: 'South Asia (India)' },
    eggplant: { world: 'Old World', region: 'South/East Asia' },
    chickpeas: { world: 'Old World', region: 'Southwest Asia' },
    lentils: { world: 'Old World', region: 'Southwest Asia' },
    soybeans: { world: 'Old World', region: 'East Asia' },
    almonds: { world: 'Old World', region: 'Southwest/Central Asia' },
    walnuts: { world: 'Old World', region: 'Persia / Central Asia' },
    pistachio: { world: 'Old World', region: 'Central/Southwest Asia' },
    sesame: { world: 'Old World', region: 'Sub-Saharan Africa / India' },
    okra: { world: 'Old World', region: 'West/East Africa' },
    watermelon: { world: 'Old World', region: 'Northeast/West Africa' },

    // Neutral exceptions explicitly allowed by Food_Truck_PBL.pdf
    salt: { world: 'Neutral', region: 'Mineral Exception (Allowed in any dish)' },
    water: { world: 'Neutral', region: 'Mineral Exception (Allowed in any dish)' },
  };

  function verifyColumbianExchangeIngredients(rawInput) {
    const tokens = String(rawInput || '')
      .split(/[,;\n]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    if (tokens.length === 0) {
      return {
        status: 'empty',
        headline: 'Enter comma-separated ingredients to classify your dish.',
        detail: '',
        items: [],
      };
    }

    const items = [];
    let oldCount = 0;
    let newCount = 0;

    for (const tok of tokens) {
      let match = COLUMBIAN_INGREDIENTS_DB[tok];
      if (!match) {
        const key = Object.keys(COLUMBIAN_INGREDIENTS_DB).find(
          (k) => tok.includes(k) || k.includes(tok)
        );
        if (key) match = COLUMBIAN_INGREDIENTS_DB[key];
      }
      if (match) {
        if (match.world.startsWith('Old World')) oldCount++;
        if (match.world.startsWith('New World')) newCount++;
        items.push({ name: tok, world: match.world, region: match.region });
      } else {
        items.push({
          name: tok,
          world: 'Verify Specific Species',
          region: 'Not in list — check the PBL source list',
        });
      }
    }

    let category = 'Mixed: Both Worlds (Old + New World)';
    if (oldCount > 0 && newCount === 0) {
      category = 'OLD WORLD ONLY (Afro-Eurasia)';
    } else if (newCount > 0 && oldCount === 0) {
      category = 'NEW WORLD ONLY (Americas)';
    }

    return {
      status: 'equivalent',
      headline: `Dish Classification: ${category}`,
      detail: `Detected ${newCount} New World and ${oldCount} Old World ingredients. Regions listed below.`,
      items,
    };
  }

  function openStudyLabDeck(deckId, problemIdx = 0, scroll = true) {
    if (!STUDY_LAB_DECKS[deckId]) deckId = 'calc_log';
    state.studyLab.activeDeck = deckId;
    state.studyLab.activeProblemIdx = problemIdx;
    state.studyLab.typedInput = '';
    state.studyLab.lastVerification = null;
    state.studyLab.showSteps = false;

    const dd = document.getElementById('studyLabDropdown');
    if (dd) dd.open = true;

    renderStudyLab();
    const sec = document.getElementById('studyLabSection');
    if (sec && scroll) {
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function initScratchpadCanvas() {
    const canvas = document.getElementById('studyScratchpadCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const drawGrid = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(140, 140, 150, 0.14)';
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
      for (const stroke of state.studyLab.scratchpadStrokes) {
        if (!stroke.points || stroke.points.length < 2) continue;
        ctx.strokeStyle = stroke.color || '#ff4f00';
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
    };

    drawGrid();

    let drawing = false;
    let currentStroke = null;

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: ((clientX - rect.left) / rect.width) * canvas.width,
        y: ((clientY - rect.top) / rect.height) * canvas.height,
      };
    };

    const startDraw = (e) => {
      e.preventDefault();
      drawing = true;
      currentStroke = { color: state.studyLab.penColor || '#ff4f00', points: [getPos(e)] };
      state.studyLab.scratchpadStrokes.push(currentStroke);
    };

    const moveDraw = (e) => {
      if (!drawing || !currentStroke) return;
      e.preventDefault();
      currentStroke.points.push(getPos(e));
      drawGrid();
    };

    const endDraw = () => {
      drawing = false;
      currentStroke = null;
    };

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', moveDraw);
    window.addEventListener('mouseup', endDraw);
    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', moveDraw, { passive: false });
    canvas.addEventListener('touchend', endDraw);
  }

  function renderStudyLab() {
    if (!els.studyDeckSidebar || !els.studyVerifierWorkspace) return;
    const deck = STUDY_LAB_DECKS[state.studyLab.activeDeck] || STUDY_LAB_DECKS.calc_log;
    const problems = deck.problems || [];
    const activeIdx = Math.min(state.studyLab.activeProblemIdx, Math.max(0, problems.length - 1));
    const problem = problems[activeIdx] || problems[0];

    // 1. Left column: deck + problem dropdowns and source handout
    const deckOptions = Object.values(STUDY_LAB_DECKS)
      .map(
        (d) =>
          `<option value="${escapeHtml(d.id)}" ${d.id === deck.id ? 'selected' : ''}>${escapeHtml(
            d.shortTitle || d.title
          )}</option>`
      )
      .join('');
    const problemOptions = problems
      .map(
        (p, idx) =>
          `<option value="${idx}" ${idx === activeIdx ? 'selected' : ''}>${escapeHtml(
            `${p.number} — ${p.prompt}`.slice(0, 90)
          )}</option>`
      )
      .join('');

    els.studyDeckSidebar.innerHTML = `
      <div class="space-y-1.5">
        <label for="studyDeckSelect" class="block text-[11px] font-bold secondary-copy">Problem set</label>
        <select id="studyDeckSelect" class="studio-select w-full text-xs">${deckOptions}</select>
      </div>
      <div class="space-y-1.5">
        <label for="studyProblemSelect" class="block text-[11px] font-bold secondary-copy">Problem</label>
        <select id="studyProblemSelect" class="studio-select w-full text-xs" ${problems.length <= 1 ? 'disabled' : ''}>${problemOptions}</select>
      </div>
      <div class="p-3.5 tone-surface-2 space-y-1">
        <p class="text-xs font-bold leading-snug">${escapeHtml(deck.title)}</p>
        <p class="text-[11px] secondary-copy">${escapeHtml(deck.subtitle)}</p>
      </div>
    `;

    const deckSel = document.getElementById('studyDeckSelect');
    if (deckSel) {
      deckSel.addEventListener('change', () => openStudyLabDeck(deckSel.value, 0, false));
    }
    const probSel = document.getElementById('studyProblemSelect');
    if (probSel) {
      probSel.addEventListener('change', () => {
        state.studyLab.activeProblemIdx = Number(probSel.value) || 0;
        state.studyLab.typedInput = '';
        state.studyLab.lastVerification = null;
        state.studyLab.showSteps = false;
        renderStudyLab();
      });
    }

    // 2. Render Right Workspace (Problem Prompt, 3 Input Mode Tabs, Live Verifier, Step-by-Step Key)
    const mode = state.studyLab.inputMode || 'type';
    const ver = state.studyLab.lastVerification;

    let resultBannerHtml = '';
    if (ver && ver.status !== 'empty') {
      const chipStyle =
        ver.status === 'equivalent'
          ? 'border-left: 4px solid var(--calm);'
          : ver.status === 'partial'
          ? 'border-left: 4px solid var(--soon);'
          : 'border-left: 4px solid var(--urgent);';
      const titleColor =
        ver.status === 'equivalent'
          ? 'var(--calm)'
          : ver.status === 'partial'
          ? 'var(--soon)'
          : 'var(--urgent)';

      const ingredientsListHtml =
        Array.isArray(ver.items) && ver.items.length > 0
          ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-2 text-xs">
              ${ver.items
                .map(
                  (it) => `
                <div class="p-2 tone-surface flex items-center justify-between gap-2">
                  <span class="font-bold capitalize">${escapeHtml(it.name)}</span>
                  <span class="context-tag">${escapeHtml(it.world)} • ${escapeHtml(it.region)}</span>
                </div>`
                )
                .join('')}
            </div>`
          : '';

      resultBannerHtml = `
        <div class="p-4 tone-surface space-y-1.5" style="${chipStyle}">
          <p class="text-sm font-bold" style="color: ${titleColor};">${escapeHtml(ver.headline)}</p>
          <p class="text-xs secondary-copy leading-relaxed">${escapeHtml(ver.detail)}</p>
          ${ingredientsListHtml}
        </div>
      `;
    }

    const teacherAlertHtml = problem.teacherAlert
      ? `<div class="p-3.5 tone-surface text-xs space-y-1" style="border-left: 4px solid var(--soon);">
          <p class="font-bold" style="color: var(--soon);">Worksheet and key differ</p>
          <p class="secondary-copy">${escapeHtml(problem.teacherAlert)}</p>
        </div>`
      : '';

    const examplePillsHtml =
      Array.isArray(problem.equivalentExamples) && problem.equivalentExamples.length > 0
        ? `<div class="flex flex-wrap items-center gap-1.5 pt-1">
            <span class="text-[11px] secondary-copy">Try:</span>
            ${problem.equivalentExamples
              .map(
                (ex) => `
              <button
                type="button"
                data-fill-example="${escapeHtml(ex)}"
                class="context-tag hover:underline font-mono text-[11px]"
                style="color: var(--accent);"
              >
                ${escapeHtml(ex)}
              </button>`
              )
              .join('')}
          </div>`
        : '';

    const customSandboxInputsHtml = deck.isCustomSandbox
      ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 tone-surface">
          <div>
            <label class="block text-[11px] font-bold secondary-copy mb-1">Target Answer Key Expression f(x, y)</label>
            <input id="customTargetExprInput" type="text" value="${escapeHtml(
              state.studyLab.customTargetExpr
            )}" class="studio-input text-xs font-mono py-1.5" />
          </div>
          <div>
            <label class="block text-[11px] font-bold secondary-copy mb-1">Optional y(x) Substitution (for Log Diff)</label>
            <input id="customOrigYExprInput" type="text" value="${escapeHtml(
              state.studyLab.customOrigYExpr
            )}" class="studio-input text-xs font-mono py-1.5" />
          </div>
        </div>`
      : '';

    let modeBodyHtml = '';
    if (mode === 'type') {
      const symbolButtons = deck.isIngredientVerifier
        ? ['corn, tomato, avocado, turkey', 'wheat, beef, cheese, onion, olive oil', 'cacao, milk, sugar, vanilla']
        : ['^2', 'sqrt(', 'ln(', 'sin(', 'cos(', 'tan(', 'cot(', 'sec(', 'csc(', 'arctan(', 'pi'];

      modeBodyHtml = `
        <div class="space-y-3">
          ${customSandboxInputsHtml}
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] secondary-copy mr-1">${
              deck.isIngredientVerifier ? 'Presets:' : 'Insert:'
            }</span>
            ${symbolButtons
              .map(
                (sym) => `
              <button type="button" data-insert-math="${escapeHtml(
                sym
              )}" class="px-2 py-1 text-xs font-mono tone-surface hover:opacity-80">
                ${escapeHtml(sym)}
              </button>`
              )
              .join('')}
          </div>
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              id="studyTypedAnswerInput"
              type="text"
              value="${escapeHtml(state.studyLab.typedInput)}"
              placeholder="${
                deck.isIngredientVerifier
                  ? 'e.g. corn, black beans, tomato, avocado, chili pepper, turkey'
                  : 'Your answer, in any equivalent form'
              }"
              class="studio-input font-mono text-sm flex-1"
            />
            <button type="button" id="verifyTypedAnswerBtn" class="studio-btn studio-btn-primary text-xs py-2.5 px-5 shrink-0">
              Check
            </button>
          </div>
          ${examplePillsHtml}
        </div>
      `;
    } else if (mode === 'draw') {
      modeBodyHtml = `
        <div class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="font-bold secondary-copy">Pen</span>
              <button type="button" data-pen-color="#ff4f00" class="w-5 h-5" style="background:#ff4f00; outline: ${
                state.studyLab.penColor === '#ff4f00' ? '2px solid var(--ink)' : 'none'
              };" title="Vermilion Ink"></button>
              <button type="button" data-pen-color="#22c55e" class="w-5 h-5" style="background:#22c55e; outline: ${
                state.studyLab.penColor === '#22c55e' ? '2px solid var(--ink)' : 'none'
              };" title="Green Ink"></button>
              <button type="button" data-pen-color="#38bdf8" class="w-5 h-5" style="background:#38bdf8; outline: ${
                state.studyLab.penColor === '#38bdf8' ? '2px solid var(--ink)' : 'none'
              };" title="Blue Ink"></button>
            </div>
            <div class="flex items-center gap-2">
              <button type="button" id="undoScratchpadBtn" class="studio-btn tone-surface text-xs py-1 px-2.5">Undo</button>
              <button type="button" id="clearScratchpadBtn" class="studio-btn tone-surface text-xs py-1 px-2.5">Clear</button>
            </div>
          </div>
          <canvas
            id="studyScratchpadCanvas"
            width="720"
            height="230"
            class="w-full tone-surface cursor-crosshair"
            style="border: 1px solid var(--surface); touch-action: none;"
          ></canvas>
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              id="studyTypedAnswerInput"
              type="text"
              value="${escapeHtml(state.studyLab.typedInput)}"
              placeholder="Type your final line to check it"
              class="studio-input font-mono text-sm flex-1"
            />
            <button type="button" id="verifyTypedAnswerBtn" class="studio-btn studio-btn-primary text-xs py-2.5 px-5 shrink-0">
              Check
            </button>
          </div>
        </div>
      `;
    } else if (mode === 'upload') {
      const meta = state.studyLab.uploadedImageMeta;
      const fileAlertHtml = meta
        ? `<div class="p-3.5 tone-surface space-y-2 text-xs" style="border-left: 4px solid ${
            meta.isHeic ? 'var(--urgent)' : 'var(--calm)'
          };">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold" style="color: ${meta.isHeic ? 'var(--urgent)' : 'var(--calm)'};">
                ${
                  meta.isHeic
                    ? '.HEIC file — Canvas teachers often can’t open these. Download the .PNG below and submit that.'
                    : `${meta.name} is a safe format`
                }
              </span>
              ${
                state.studyLab.uploadedImageDataUrl
                  ? `<a href="${state.studyLab.uploadedImageDataUrl}" download="converted-work.png" class="studio-btn studio-btn-primary text-[11px] py-1 px-2.5">Download Safe .PNG</a>`
                  : ''
              }
            </div>
            ${
              state.studyLab.uploadedImageDataUrl
                ? `<img src="${state.studyLab.uploadedImageDataUrl}" alt="Uploaded student work" class="max-h-48 object-contain tone-surface-2 p-2" />`
                : ''
            }
          </div>`
        : '';

      modeBodyHtml = `
        <div class="space-y-3">
          <div class="p-5 tone-surface space-y-2 text-center" style="border: 1px dashed var(--ink-secondary);">
            <p class="text-sm font-bold">Upload a photo of your work or a screenshot</p>
            <p class="text-xs secondary-copy">
              HEIC photos are converted to .PNG so you can submit them. Type your final line below to check it.
            </p>
            <div class="pt-2">
              <label for="studyWorkImageInput" class="cursor-pointer studio-btn studio-btn-primary text-xs py-2 px-4">
                Choose image
              </label>
              <input id="studyWorkImageInput" type="file" accept="image/*,.heic,.heif" class="hidden" />
            </div>
          </div>
          ${fileAlertHtml}
          <div class="flex flex-col sm:flex-row gap-2">
            <input
              id="studyTypedAnswerInput"
              type="text"
              value="${escapeHtml(state.studyLab.typedInput)}"
              placeholder="Type your final line to check it"
              class="studio-input font-mono text-sm flex-1"
            />
            <button type="button" id="verifyTypedAnswerBtn" class="studio-btn studio-btn-primary text-xs py-2.5 px-5 shrink-0">
              Check
            </button>
          </div>
        </div>
      `;
    }

    const stepsHtml = state.studyLab.showSteps
      ? `<div class="p-4 tone-surface space-y-2 text-xs">
          <p class="font-bold" style="color: var(--accent);">Solution Key &amp; Derivation (<span class="math-font font-math">${formatMathHtml(problem.canonicalDisplay)}</span>)</p>
          <ul class="space-y-1.5 secondary-copy font-mono text-[11px]">
            ${(problem.steps || []).map((st) => `<li class="font-math math-font">${formatMathHtml(st)}</li>`).join('')}
          </ul>
        </div>`
      : '';

    els.studyVerifierWorkspace.innerHTML = `
      <div class="flex flex-wrap items-start justify-between gap-3" style="border-bottom: 1px solid var(--surface); padding-bottom: 1rem;">
        <div class="space-y-1">
          <span class="context-tag context-tag-accent">${escapeHtml(problem.number)}</span>
          <h3 class="text-base font-bold font-math leading-snug math-font">${formatMathHtml(problem.prompt)}</h3>
        </div>
        <div class="flex items-center gap-1.5" role="tablist" aria-label="Verification Input Mode">
          <button type="button" data-study-mode="type" class="studio-btn text-xs py-1.5 px-3 ${
            mode === 'type' ? 'studio-btn-primary' : 'tone-surface'
          }">
            Type
          </button>
          <button type="button" data-study-mode="draw" class="studio-btn text-xs py-1.5 px-3 ${
            mode === 'draw' ? 'studio-btn-primary' : 'tone-surface'
          }">
            Draw
          </button>
          <button type="button" data-study-mode="upload" class="studio-btn text-xs py-1.5 px-3 ${
            mode === 'upload' ? 'studio-btn-primary' : 'tone-surface'
          }">
            Upload
          </button>
        </div>
      </div>

      ${teacherAlertHtml}
      ${modeBodyHtml}
      ${resultBannerHtml}

      <div class="pt-2 flex flex-wrap items-center justify-between gap-2 text-xs" style="border-top: 1px solid var(--surface);">
        <button type="button" id="toggleStudyStepsBtn" class="underline font-bold" style="color: var(--ink);">
          ${state.studyLab.showSteps ? 'Hide Solution Key' : 'Show Solution Key & Steps'}
        </button>
        <span class="secondary-copy">Accepts any algebraically or trigonometrically equivalent form</span>
      </div>

      ${stepsHtml}
    `;

    // Bind Workspace Controls
    els.studyVerifierWorkspace.querySelectorAll('[data-study-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.studyLab.inputMode = btn.getAttribute('data-study-mode') || 'type';
        renderStudyLab();
      });
    });

    const typedInp = document.getElementById('studyTypedAnswerInput');
    const runVerification = () => {
      if (typedInp) state.studyLab.typedInput = typedInp.value;
      if (deck.isCustomSandbox) {
        const tInp = document.getElementById('customTargetExprInput');
        const yInp = document.getElementById('customOrigYExprInput');
        if (tInp) state.studyLab.customTargetExpr = tInp.value;
        if (yInp) state.studyLab.customOrigYExpr = yInp.value;
        problem.targetExpr = state.studyLab.customTargetExpr;
        problem.origYExpr = state.studyLab.customOrigYExpr;
        problem.canonicalDisplay = state.studyLab.customTargetExpr;
      }
      if (deck.isIngredientVerifier) {
        state.studyLab.lastVerification = verifyColumbianExchangeIngredients(
          state.studyLab.typedInput
        );
      } else {
        state.studyLab.lastVerification = verifyMathEquivalence(
          state.studyLab.typedInput,
          problem
        );
      }
      renderStudyLab();
    };

    const verifyBtn = document.getElementById('verifyTypedAnswerBtn');
    if (verifyBtn) verifyBtn.addEventListener('click', runVerification);
    if (typedInp) {
      typedInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runVerification();
        }
      });
    }

    els.studyVerifierWorkspace.querySelectorAll('[data-insert-math]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sym = btn.getAttribute('data-insert-math') || '';
        if (typedInp) {
          typedInp.value = deck.isIngredientVerifier ? sym : `${typedInp.value}${sym}`;
          state.studyLab.typedInput = typedInp.value;
          typedInp.focus();
        }
      });
    });

    els.studyVerifierWorkspace.querySelectorAll('[data-fill-example]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ex = btn.getAttribute('data-fill-example') || '';
        state.studyLab.typedInput = ex;
        if (typedInp) typedInp.value = ex;
        runVerification();
      });
    });

    const toggleStepsBtn = document.getElementById('toggleStudyStepsBtn');
    if (toggleStepsBtn) {
      toggleStepsBtn.addEventListener('click', () => {
        state.studyLab.showSteps = !state.studyLab.showSteps;
        renderStudyLab();
      });
    }

    if (mode === 'draw') {
      initScratchpadCanvas();
      els.studyVerifierWorkspace.querySelectorAll('[data-pen-color]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.studyLab.penColor = btn.getAttribute('data-pen-color') || '#ff4f00';
          renderStudyLab();
        });
      });
      const undoBtn = document.getElementById('undoScratchpadBtn');
      if (undoBtn) {
        undoBtn.addEventListener('click', () => {
          state.studyLab.scratchpadStrokes.pop();
          renderStudyLab();
        });
      }
      const clearBtn = document.getElementById('clearScratchpadBtn');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          state.studyLab.scratchpadStrokes = [];
          renderStudyLab();
        });
      }
    }

    if (mode === 'upload') {
      const fileInp = document.getElementById('studyWorkImageInput');
      if (fileInp) {
        fileInp.addEventListener('change', (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          const isHeic =
            /\.heic$|\.heif$/i.test(f.name) || /heic|heif/i.test(f.type || '');
          state.studyLab.uploadedImageMeta = {
            name: f.name,
            size: f.size,
            type: f.type || (isHeic ? 'image/heic' : 'image/png'),
            isHeic,
          };
          const reader = new FileReader();
          reader.onload = () => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement('canvas');
              c.width = img.width;
              c.height = img.height;
              c.getContext('2d').drawImage(img, 0, 0);
              state.studyLab.uploadedImageDataUrl = c.toDataURL('image/png');
              state.studyLab.showSteps = true;
              renderStudyLab();
            };
            img.onerror = () => {
              state.studyLab.uploadedImageDataUrl = null;
              state.studyLab.showSteps = true;
              renderStudyLab();
            };
            img.src = reader.result;
          };
          reader.readAsDataURL(f);
        });
      }
    }
  }

  
  // -------------------------------------------------------------------------
  // 10b. Resources Vault (Textbooks, Syllabi, Calendars & Problem Keys)
  // -------------------------------------------------------------------------
  function renderResourceClassTabs() {
    const container = document.getElementById('resourceClassTabs');
    if (!container) return;
    const resources = state.resources.length > 0 ? state.resources : getCuratedCourseResources(state.canvasBaseUrl);

    const courseMap = new Map();
    for (const r of resources) {
      if (r.course_id && !courseMap.has(String(r.course_id))) {
        courseMap.set(String(r.course_id), r.course_name || `Class ${r.course_id}`);
      }
    }
    for (const c of (state.courses || [])) {
      if (!courseMap.has(String(c.id))) {
        courseMap.set(String(c.id), c.name || `Class ${c.id}`);
      }
    }

    let html = `<button type="button" data-res-class="all" class="res-class-tab studio-btn ${
      state.resourceClassFilter === 'all' ? 'studio-btn-primary' : 'tone-surface'
    } text-xs py-1 px-2.5 font-bold">All Classes</button>`;

    for (const [cid, cname] of courseMap.entries()) {
      const isSel = String(state.resourceClassFilter) === String(cid);
      const shortName = cname.replace(/^(P\d+\s*[-–]\s*)/i, '').replace(/:\s*Modern/i, '').split(' - ')[0].slice(0, 16);
      html += `<button type="button" data-res-class="${escapeHtml(cid)}" class="res-class-tab studio-btn ${
        isSel ? 'studio-btn-primary' : 'tone-surface'
      } text-xs py-1 px-2.5">${escapeHtml(shortName)}</button>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.res-class-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.resourceClassFilter = btn.getAttribute('data-res-class') || 'all';
        state.resourcePage = 1;
        state.resourcesPage = 1;
        renderResourceClassTabs();
        renderResourcesVault();
      });
    });
  }

  function renderResourcesVault() {
    renderResourceClassTabs();
    if (!els.resourcesGrid) return;
    const resources = state.resources.length > 0 ? state.resources : getCuratedCourseResources(state.canvasBaseUrl);

    const filtered = resources.filter((res) => {
      if (state.resourceClassFilter !== 'all' && String(res.course_id) !== String(state.resourceClassFilter)) {
        return false;
      }
      if (state.resourceCategoryFilter !== 'all' && res.category !== state.resourceCategoryFilter) {
        return false;
      }
      if (state.resourceSearch) {
        const q = state.resourceSearch.toLowerCase();
        const searchable = `${res.title || ''} ${res.description || ''} ${res.unit || ''} ${res.instructor || ''} ${res.format || ''}`.toLowerCase();
        if (!searchable.includes(q)) return false;
      }
      return true;
    });

    if (els.resourceCountBadge) {
      els.resourceCountBadge.textContent = `${filtered.length} items`;
    }

    if (filtered.length === 0) {
      els.resourcesGrid.innerHTML = `
        <div class="col-span-full p-8 tone-surface space-y-2 text-center">
          <p class="font-bold">No resources match your search or filter.</p>
          <p class="secondary-copy text-xs">Try resetting the class filter or searching for another chapter.</p>
        </div>`;
      return;
    }

    const RES_PAGE_SIZE = 9;
    const totalResPages = Math.max(1, Math.ceil(filtered.length / RES_PAGE_SIZE));
    if (!state.resourcePage || state.resourcePage < 1) state.resourcePage = 1;
    if (state.resourcePage > totalResPages) state.resourcePage = totalResPages;
    state.resourcesPage = state.resourcePage;

    const resPageItems = filtered.slice((state.resourcePage - 1) * RES_PAGE_SIZE, state.resourcePage * RES_PAGE_SIZE);

    els.resourcesGrid.innerHTML = resPageItems.map((item) => {
      const formatTagClass =
        item.format === 'pdf' ? 'format-tag-pdf' :
        item.format === 'docx' ? 'format-tag-docx' :
        item.format === 'slides' ? 'format-tag-slides' : 'format-tag-link';

      return `
        <article class="p-4 tone-surface flex flex-col justify-between gap-3 transition hover:shadow-sm" style="border: 1px solid var(--surface-2);">
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <span class="format-tag ${formatTagClass}">
                ${String(item.format || 'FILE').toUpperCase()}
              </span>
              <span class="text-[11px] tabular secondary-copy font-bold">
                ${escapeHtml(item.size_label || '')}
              </span>
            </div>

            <div>
              <span class="text-[10px] font-bold tracking-wide uppercase secondary-copy block mb-0.5">
                ${escapeHtml(item.course_name || 'Class Resource')}
              </span>
              <h3 class="text-sm font-bold leading-snug">
                ${escapeHtml(item.title)}
              </h3>
            </div>

            <p class="text-xs secondary-copy line-clamp-3 leading-relaxed">
              ${escapeHtml(item.description || '')}
            </p>

            ${item.unit ? `<span class="context-tag text-[10px]">${escapeHtml(item.unit)}</span>` : ''}
          </div>

          <div class="flex items-center justify-between pt-2" style="border-top: 1px solid var(--surface-2);">
            <span class="text-[11px] font-semibold secondary-copy">
              ${escapeHtml(item.instructor || '')}
            </span>
            <div class="flex items-center gap-2">
              ${item.preview_url ? `
                <a
                  href="${escapeHtml(safeHttpUrl(item.preview_url) || '#')}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="studio-btn tone-surface-2 text-xs py-1 px-2.5"
                  title="Open or preview in Canvas"
                >
                  Preview
                </a>
              ` : ''}
              <a
                href="${escapeHtml(safeHttpUrl(item.download_url) || '#')}"
                target="_blank"
                rel="noopener noreferrer"
                class="studio-btn studio-btn-primary text-xs py-1 px-3 font-bold"
                download
                title="Download reference"
              >
                Download ↓
              </a>
            </div>
          </div>
        </article>
      `;
    }).join('');

    if (els.resourcesPaginationBar) {
      if (totalResPages <= 1) {
        els.resourcesPaginationBar.innerHTML = `<span class="page-info text-xs secondary-copy">Showing ${filtered.length} resources</span>`;
      } else {
        els.resourcesPaginationBar.innerHTML = `
          <div class="flex items-center justify-between w-full">
            <button type="button" class="page-btn" id="resPrevPageBtn" ${state.resourcePage <= 1 ? 'disabled style="opacity:0.4; pointer-events:none;"' : ''}>← Prev</button>
            <span class="page-info text-xs font-semibold secondary-copy">Page ${state.resourcePage} of ${totalResPages} (${filtered.length} total)</span>
            <button type="button" class="page-btn" id="resNextPageBtn" ${state.resourcePage >= totalResPages ? 'disabled style="opacity:0.4; pointer-events:none;"' : ''}>Next →</button>
          </div>
        `;
        const prev = els.resourcesPaginationBar.querySelector('#resPrevPageBtn');
        const next = els.resourcesPaginationBar.querySelector('#resNextPageBtn');
        if (prev) prev.addEventListener('click', () => { state.resourcePage--; state.resourcesPage = state.resourcePage; renderResourcesVault(); });
        if (next) next.addEventListener('click', () => { state.resourcePage++; state.resourcesPage = state.resourcePage; renderResourcesVault(); });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 10c. Conder's AP World Official Unit Pacing Sync & Milestones
  // -------------------------------------------------------------------------
  function renderPacingTimeline() {
    if (!els.pacingTimelineList) return;
    const cal = state.pacingCalendar || CONDER_PACING_CALENDAR;
    const milestones = cal.milestones || [];
    const todayStr = localDateKey();

    const total = milestones.length;
    const passed = milestones.filter((m) => m.date <= todayStr).length;
    const pct = Math.min(100, Math.max(12, Math.round((passed / total) * 100)));
    if (els.pacingProgressBar) els.pacingProgressBar.style.width = `${pct}%`;
    if (els.pacingProgressText) {
      const curMilestone = milestones.find((m) => m.date >= todayStr) || milestones[milestones.length - 1];
      els.pacingProgressText.textContent = `${pct}% Month Complete · Next Target: ${curMilestone ? curMilestone.label : 'Unit 4 Exam'}`;
    }

    const resources = state.resources.length > 0 ? state.resources : getCuratedCourseResources(state.canvasBaseUrl);

    els.pacingTimelineList.innerHTML = milestones.map((m) => {
      const isToday = m.date === todayStr;
      const isPast = m.date < todayStr;
      const itemClass = isToday ? 'pacing-milestone milestone-today' :
                        m.is_major || m.is_assessment ? 'pacing-milestone milestone-assessment' :
                        m.is_holiday ? 'pacing-milestone milestone-holiday' : 'pacing-milestone';

      const formattedDate = new Date(`${m.date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });

      let readingLinkHtml = '';
      if (m.reading_chapter) {
        const resId = `res_world_ch${m.reading_chapter}`;
        const res = resources.find((r) => r.id === resId);
        if (res) {
          readingLinkHtml = `
            <a
              href="${escapeHtml(safeHttpUrl(res.download_url) || '#')}"
              target="_blank"
              rel="noopener noreferrer"
              class="context-tag context-tag-accent ml-2 hover:underline text-[11px] font-bold"
              title="Directly download Chapter ${m.reading_chapter} PDF"
            >
              Ch. ${m.reading_chapter} PDF ↗
            </a>
          `;
        }
      }

      return `
        <div class="p-3.5 tone-surface ${itemClass} flex flex-col sm:flex-row sm:items-center justify-between gap-3" style="${isPast ? 'opacity: 0.75;' : ''} ${isToday ? 'border-left: 3px solid var(--accent);' : ''}">
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-bold tabular">
                ${escapeHtml(formattedDate)}
              </span>
              <span class="context-tag font-bold ${m.is_holiday ? '' : 'context-tag-accent'}">
                ${escapeHtml(m.day_type)}
              </span>
              ${m.is_major ? '<span class="context-tag font-bold" style="background: var(--urgent); color: #fff;">UNIT TEST</span>' : ''}
              ${m.is_assessment && !m.is_major ? '<span class="context-tag font-bold" style="background: var(--soon); color: #fff;">QUIZ</span>' : ''}
              ${isToday ? '<span class="context-tag font-bold" style="background: var(--accent); color: #fff;">TODAY</span>' : ''}
            </div>

            <h4 class="text-sm font-bold leading-snug">
              ${escapeHtml(m.label)}
            </h4>

            <p class="text-xs secondary-copy">
              ${escapeHtml(m.detail)}
            </p>

            ${m.reading ? `
              <div class="pt-1 flex items-center text-xs font-semibold">
                <span style="color: var(--accent);">Read: ${escapeHtml(m.reading)}</span>
                ${readingLinkHtml}
              </div>
            ` : ''}
          </div>

          <div class="shrink-0 flex items-center gap-2">
            <button
              type="button"
              data-add-milestone-gcal="${escapeHtml(m.date)}"
              class="studio-btn tone-surface-2 text-xs py-1 px-2.5 font-bold"
              title="Add milestone to Google Calendar"
            >
              + GCal
            </button>
          </div>
        </div>
      `;
    }).join('');

    els.pacingTimelineList.querySelectorAll('[data-add-milestone-gcal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dt = btn.getAttribute('data-add-milestone-gcal');
        const m = milestones.find((item) => item.date === dt);
        if (m) {
          const title = encodeURIComponent(`AP World: ${m.label}`);
          const datesParam = `&dates=${m.date.replace(/-/g, '')}T130000Z/${m.date.replace(/-/g, '')}T143000Z`;
          const details = encodeURIComponent(`${m.detail}\nReading: ${m.reading || 'None'}\n\nPacing Calendar: Conder AP World`);
          const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}${datesParam}&details=${details}&location=Enloe%20High%20School`;
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      });
    });
  }

  function safeRender(name, fn, fallbackEl) {
    try {
      fn();
    } catch (err) {
      console.warn(`[Slated SafeRender Warning] in ${name}:`, err);
      if (fallbackEl) {
        fallbackEl.innerHTML = `
          <div class="p-4 tone-surface border border-red-500/30 rounded text-xs space-y-1">
            <p class="font-bold text-red-500">Notice: Unable to render ${escapeHtml(name)}.</p>
            <p class="secondary-copy">An unexpected data format was encountered. The rest of your dashboard remains fully functional.</p>
          </div>
        `;
      }
    }
  }

  function renderAll() {
    buildCourseContextMap();
    autoInitializeSavedBriefings();

    const allCombined = getCombinedAssignments();
    const baseFilteredAssignments = allCombined.filter((a) => {
      const course = getCourseById(a.course_id);
      const searchable = `${a.name || ''} ${a.description || ''} ${a.context_badge || ''} ${
        a.context_note || ''
      } ${course ? `${course.name} ${course.course_code}` : ''}`;
      return matchesSearchAndCourse(a.course_id, searchable);
    });

    const filteredAnnouncements = state.announcements.filter((ann) => {
      const courseId = String(ann.context_code || '').replace(/^course_/, '');
      const course = getCourseById(courseId);
      const searchable = `${ann.title || ''} ${ann.clean_text || ann.message || ''} ${
        ann.author_name || ''
      } ${course ? `${course.name} ${course.course_code}` : ''}`;
      return matchesSearchAndCourse(courseId, searchable);
    });

    safeRender('Metrics & Counts', () => renderMetricsAndCounts(baseFilteredAssignments));
    safeRender('Gameplan Strip', () => renderGameplanStrip(baseFilteredAssignments));
    safeRender('Bell Schedule', () => renderBellScheduleStrip());
    safeRender('Course Cards', () => renderCourseCards(), els.courseCardsGrid);
    safeRender('Assignments Queue', () => renderAssignments(baseFilteredAssignments), els.assignmentsList);
    safeRender('Study Lab', () => renderStudyLab());
    safeRender('Briefings Drawer', () => renderSavedBriefingsDrawer());
    safeRender('Teacher Briefings', () => renderAnnouncements(filteredAnnouncements), els.announcementsList);
    safeRender('Resources Vault', () => renderResourcesVault(), els.resourcesGrid);
    safeRender('Pacing Timeline', () => renderPacingTimeline(), els.pacingTimelineGrid);
    safeRender('Calendar', () => renderCalendar(baseFilteredAssignments), els.calendarGrid);
    if (state.inspectorCourseId) {
      safeRender('Course Inspector', () => renderCourseInspector(), els.courseInspectorBody);
    }
  }

  // -------------------------------------------------------------------------
  // 11. Data Loading (Node Backend + Token-Keyed WebCrypto Snapshot on Beacon.host)
  // -------------------------------------------------------------------------
  const OFFLINE_CACHE_KEY = 'slated_offline_cache_v2';

  function saveToOfflineCache() {
    try {
      const payload = {
        timestamp: Date.now(),
        courses: state.courses,
        assignments: state.assignments,
        announcements: state.announcements,
        courseContexts: state.courseContexts,
        resources: state.resources,
        pacingCalendar: state.pacingCalendar,
      };
      setStoredItem('localStorage', OFFLINE_CACHE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to save to offline continuity cache:', e);
    }
  }

  function loadFromOfflineCache() {
    try {
      const raw = getStoredItem('localStorage', OFFLINE_CACHE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        !Array.isArray(parsed.courses) ||
        !Array.isArray(parsed.assignments) ||
        !Array.isArray(parsed.announcements) ||
        (parsed.courseContexts != null &&
          (typeof parsed.courseContexts !== 'object' || Array.isArray(parsed.courseContexts))) ||
        (parsed.resources != null && !Array.isArray(parsed.resources))
      ) {
        console.warn('Offline continuity cache has an invalid data shape.');
        return false;
      }
      state.courses = parsed.courses;
      state.assignments = parsed.assignments;
      state.announcements = parsed.announcements.map(ensureAnnouncementSummarized);
      state.courseContexts = parsed.courseContexts || {};
      state.resources = parsed.resources || [];
      state.pacingCalendar = parsed.pacingCalendar || null;
      return true;
    } catch (e) {
      console.warn('Failed to load from offline continuity cache:', e);
      return false;
    }
  }

  async function loadDashboardData(forceRefresh = false) {
    const qs = forceRefresh ? '?refresh=true' : '';
    if (els.syncStatusText) {
      els.syncStatusText.textContent = forceRefresh ? 'Syncing...' : 'Loading...';
    }

    if (state.cloudStaticMode) {
      if (unlockedSnapshotData) {
        state.courses = Array.isArray(unlockedSnapshotData.courses)
          ? unlockedSnapshotData.courses
          : [];
        state.assignments = Array.isArray(unlockedSnapshotData.assignments)
          ? unlockedSnapshotData.assignments
          : [];
        state.announcements = Array.isArray(unlockedSnapshotData.announcements)
          ? unlockedSnapshotData.announcements.map(ensureAnnouncementSummarized)
          : [];
        if (unlockedSnapshotData.courseContexts) {
          state.courseContexts = unlockedSnapshotData.courseContexts;
        }
        if (unlockedSnapshotData.resources) {
          state.resources = unlockedSnapshotData.resources;
        }
        if (unlockedSnapshotData.pacingCalendar) {
          state.pacingCalendar = unlockedSnapshotData.pacingCalendar;
        }
        if (els.syncStatusText) {
          els.syncStatusText.textContent = 'Synced';
        }
        saveToOfflineCache();
        renderCourseSelectors();
        renderAll();
        return;
      }

      const baseUrl =
        (browserRamCreds && browserRamCreds.canvasBaseUrl) || 'https://wcpss.instructure.com';
      const token = browserRamCreds && browserRamCreds.canvasApiToken;
      if (token) {
        try {
          logSecurityEvent('GET', `${baseUrl}/api/v1/courses`, 'Direct Read-Only CORS');
          const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
          const origin = new URL(baseUrl).origin;
          const fetchCanvasPages = async (initialUrl, pageSize = 100) => {
            const items = [];
            let nextUrl = initialUrl;
            let pages = 0;
            const seenUrls = new Set();
            while (nextUrl) {
              if (pages >= 100) {
                throw new Error('Canvas pagination exceeded the 100-page limit.');
              }
              const requestUrl = new URL(nextUrl, baseUrl);
              if (
                requestUrl.origin !== origin ||
                !requestUrl.pathname.startsWith('/api/v1/') ||
                requestUrl.username ||
                requestUrl.password
              ) {
                throw new Error('Canvas returned an invalid pagination URL.');
              }
              if (seenUrls.has(requestUrl.href)) {
                throw new Error('Canvas pagination contains a repeated page.');
              }
              seenUrls.add(requestUrl.href);
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 15000);
              let response;
              let page;
              try {
                response = await fetch(requestUrl.href, {
                  headers,
                  redirect: 'error',
                  signal: controller.signal,
                });
                if (!response.ok) {
                  throw new Error(`Canvas request failed (HTTP ${response.status}).`);
                }
                page = await response.json();
              } finally {
                clearTimeout(timeout);
              }
              if (response.url) {
                const finalUrl = new URL(response.url);
                if (finalUrl.origin !== origin || !finalUrl.pathname.startsWith('/api/v1/')) {
                  throw new Error('Canvas redirected the API request to an invalid URL.');
                }
              }
              if (!Array.isArray(page)) throw new Error('Canvas returned an invalid list response.');
              items.push(...page);
              if (items.length > 10000) {
                throw new Error('Canvas pagination exceeded the 10,000-item limit.');
              }
              pages += 1;

              const linkHeader = response.headers.get('Link') || '';
              const nextLink = linkHeader.match(/<([^>]+)>;\s*rel=["']?next["']?/i);
              if (!nextLink) {
                if (page.length >= pageSize) {
                  throw new Error('Canvas pagination metadata is unavailable; results may be incomplete.');
                }
                nextUrl = null;
                continue;
              }
              nextUrl = new URL(nextLink[1], requestUrl).href;
            }
            return items;
          };

          const directCourses = await fetchCanvasPages(
            `${baseUrl}/api/v1/courses?enrollment_state=active&include[]=term&include[]=teachers&per_page=100`
          );
          const courses = directCourses.filter((c) => c && c.name && !c.access_restricted_by_date);
          const assignLists = [];
          for (let index = 0; index < courses.length; index += 4) {
            const courseBatch = courses.slice(index, index + 4);
            const batchAssignments = await Promise.all(
              courseBatch.map((course) =>
                fetchCanvasPages(
                  `${baseUrl}/api/v1/courses/${encodeURIComponent(course.id)}/assignments?per_page=100&order_by=due_at&include[]=submission`
                )
              )
            );
            assignLists.push(...batchAssignments);
          }
          const upcomingEvents = await fetchCanvasPages(
            `${baseUrl}/api/v1/users/self/upcoming_events?per_page=100`
          );
          const announcements = [];
          for (let index = 0; index < courses.length; index += 10) {
            const query = new URLSearchParams();
            courses.slice(index, index + 10).forEach((course) => {
              query.append('context_codes[]', `course_${course.id}`);
            });
            query.set('start_date', `${new Date().getFullYear() - 1}-01-01T00:00:00Z`);
            query.set('end_date', `${new Date().getFullYear() + 2}-12-31T23:59:59Z`);
            query.set('per_page', '100');
            announcements.push(
              ...(await fetchCanvasPages(`${baseUrl}/api/v1/announcements?${query.toString()}`))
            );
          }

          const assignmentMap = new Map(
            assignLists.flat().filter((assignment) => assignment && assignment.id)
              .map((assignment) => [String(assignment.id), assignment])
          );
          upcomingEvents.forEach((event) => {
            const assignment = event.assignment;
            if (assignment && assignment.id && !assignmentMap.has(String(assignment.id))) {
              assignmentMap.set(String(assignment.id), assignment);
            }
          });
          state.courses = courses;
          state.assignments = Array.from(assignmentMap.values());
          state.announcements = announcements.map(ensureAnnouncementSummarized);
          state.courseContexts = {};
          if (els.syncStatusText) els.syncStatusText.textContent = 'Live';
          saveToOfflineCache();
          renderCourseSelectors();
          renderAll();
          return;
        } catch (error) {
          console.warn('Static Canvas sync failed:', error);
        }
      }

      const restored = loadFromOfflineCache();
      if (restored) {
        if (els.syncStatusText) els.syncStatusText.textContent = 'Offline (Cached)';
        if (els.offlineStatusBadge) els.offlineStatusBadge.classList.remove('hidden');
        renderCourseSelectors();
        renderAll();
        showToast('Operating offline. Displaying cached dashboard data.', 3500);
      } else {
        if (els.syncStatusText) els.syncStatusText.textContent = 'Offline';
        showToast('Canvas data could not be loaded and no valid offline cache is available.', 5000);
        renderCourseSelectors();
        renderAll();
      }
      return;
    }

    try {
      const [coursesRes, eventsRes, announcementsRes] = await Promise.all([
        apiFetch(`/api/v1/courses?enrollment_state=active${forceRefresh ? '&refresh=true' : ''}`),
        apiFetch(`/api/v1/users/self/upcoming_events${qs}`),
        apiFetch(`/api/v1/announcements${qs}`),
      ]);

      const authFailure = [coursesRes, eventsRes, announcementsRes].find(
        (response) => response.status === 401 || response.status === 428
      );
      if (authFailure) {
        let errText = '';
        try {
          errText = await authFailure.text();
        } catch (_) {}
        if (authFailure.status === 401 && /token|expired|unauthori[sz]ed|invalid/i.test(errText)) {
          handleTokenRejected();
        }
        state.authenticated = false;
        await updateViewForAuthState();
        return;
      }

      for (const [label, response] of [
        ['Courses', coursesRes],
        ['Upcoming events', eventsRes],
        ['Announcements', announcementsRes],
      ]) {
        if (!response.ok) throw new Error(`${label} request failed (HTTP ${response.status}).`);
      }

      const [courses, upcomingEvents, announcements] = await Promise.all([
        coursesRes.json(),
        eventsRes.json(),
        announcementsRes.json(),
      ]);
      if (
        !Array.isArray(courses) ||
        !Array.isArray(upcomingEvents) ||
        !Array.isArray(announcements)
      ) {
        throw new Error('Canvas returned an invalid dashboard response.');
      }

      const perCourseLists = [];
      const perCourseContexts = [];
      for (let index = 0; index < courses.length; index += 4) {
        const courseBatch = courses.slice(index, index + 4);
        const [assignmentBatch, contextBatch] = await Promise.all([
          Promise.all(
            courseBatch.map(async (course) => {
              const response = await apiFetch(
                `/api/v1/courses/${encodeURIComponent(course.id)}/assignments${qs}`
              );
              if (!response.ok) {
                throw new Error(
                  `Assignments for course ${course.id} failed (HTTP ${response.status}).`
                );
              }
              const assignments = await response.json();
              if (!Array.isArray(assignments)) {
                throw new Error(`Assignments for course ${course.id} have an invalid response.`);
              }
              return assignments;
            })
          ),
          Promise.all(
            courseBatch.map(async (course) => {
              try {
                const response = await apiFetch(
                  `/api/v1/courses/${encodeURIComponent(course.id)}/context${qs}`
                );
                if (!response.ok) {
                  throw new Error(`Context request failed (HTTP ${response.status}).`);
                }
                const context = await response.json();
                if (!context || typeof context !== 'object' || Array.isArray(context)) {
                  throw new Error('Context response has an invalid shape.');
                }
                return context;
              } catch (error) {
                console.warn(`Course context unavailable for ${course.id}:`, error.message);
                return null;
              }
            })
          ),
        ]);
        perCourseLists.push(...assignmentBatch);
        perCourseContexts.push(...contextBatch);
      }

      const courseContexts = {};
      for (const ctxObj of perCourseContexts) {
        if (ctxObj && ctxObj.course_id) {
          courseContexts[String(ctxObj.course_id)] = {
            modules: Array.isArray(ctxObj.modules) ? ctxObj.modules : [],
            groups: Array.isArray(ctxObj.groups) ? ctxObj.groups : [],
          };
        }
      }

      const assignmentMap = new Map();
      for (const list of perCourseLists) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (item && item.id) {
            assignmentMap.set(String(item.id), item);
          }
        }
      }

      for (const ev of upcomingEvents) {
        const a = ev.assignment || {
          id: ev.id,
          course_id: String(ev.context_code || '').replace(/^course_/, ''),
          name: ev.title,
          due_at: ev.start_at || ev.end_at,
          html_url: ev.html_url,
          description: ev.description || '',
          is_submitted: false,
        };
        if (a && a.id && !assignmentMap.has(String(a.id))) {
          assignmentMap.set(String(a.id), a);
        }
      }

      state.courses = courses;
      state.courseContexts = courseContexts;
      state.assignments = Array.from(assignmentMap.values());
      state.announcements = announcements.map(ensureAnnouncementSummarized);

      const cacheHeader = coursesRes.headers.get('X-Cache-Hit') === 'true';
      if (els.syncStatusText) {
        els.syncStatusText.textContent = cacheHeader ? 'Cached (5m)' : 'Live';
      }

      const [resourcesResult, pacingResult] = await Promise.allSettled([
        apiFetch(`/api/v1/resources${qs}`).then(async (response) => {
          if (!response.ok) throw new Error(`Resources failed (HTTP ${response.status}).`);
          return response.json();
        }),
        apiFetch(`/api/v1/pacing-calendar${qs}`).then(async (response) => {
          if (!response.ok) throw new Error(`Pacing calendar failed (HTTP ${response.status}).`);
          return response.json();
        }),
      ]);
      if (resourcesResult.status === 'fulfilled' && Array.isArray(resourcesResult.value)) {
        state.resources = resourcesResult.value;
      } else {
        console.warn(
          'Could not refresh course resources:',
          resourcesResult.status === 'rejected' ? resourcesResult.reason : 'Invalid response shape'
        );
      }
      if (
        pacingResult.status === 'fulfilled' &&
        pacingResult.value &&
        typeof pacingResult.value === 'object' &&
        !Array.isArray(pacingResult.value)
      ) {
        state.pacingCalendar = pacingResult.value;
      } else {
        console.warn(
          'Could not refresh pacing calendar:',
          pacingResult.status === 'rejected' ? pacingResult.reason : 'Invalid response shape'
        );
      }

      renderCourseSelectors();
      renderAll();
      saveToOfflineCache();
    } catch (err) {
      console.warn('Failed to load live data, checking offline continuity cache:', err);
      const restored = loadFromOfflineCache();
      if (restored) {
        if (els.syncStatusText) els.syncStatusText.textContent = 'Offline (Cached)';
        if (els.offlineStatusBadge) els.offlineStatusBadge.classList.remove('hidden');
        renderCourseSelectors();
        renderAll();
        showToast('Operating offline. Displaying cached dashboard data.', 3500);
        return;
      }
      if (els.syncStatusText) {
        els.syncStatusText.textContent = 'Offline';
      }
      showToast('Dashboard data could not be refreshed and no valid offline cache is available.', 5000);
    }
  }

  // -------------------------------------------------------------------------
  // 11b. Google Calendar Sync & Client-Side .ics Generator
  // -------------------------------------------------------------------------
  function openGoogleCalendarEvent(assignment) {
    const course = getCourseById(assignment.course_id);
    const meta = course ? parseCourseMeta(course) : { period: '', title: '' };
    const title = encodeURIComponent(`${meta.period ? meta.period + ' · ' : ''}${assignment.name}`);
    const due = assignment.effective_due_at || assignment.due_at;
    let datesParam = '';
    if (due) {
      const dueDate = new Date(due);
      const startDate = new Date(dueDate.getTime() - 45 * 60 * 1000);
      const toGcalIso = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      datesParam = `&dates=${toGcalIso(startDate)}/${toGcalIso(dueDate)}`;
    }
    const details = encodeURIComponent(
      `Class: ${meta.title || (course ? course.name : 'Course')}\nDue: ${due ? new Date(due).toLocaleString() : 'No date'}\nPoints: ${assignment.points_possible || 'N/A'}\n\nManaged via Slated: ${window.location.origin}`
    );
    const location = encodeURIComponent(meta.title || (course ? course.name : 'School'));
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}${datesParam}&details=${details}&location=${location}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function downloadIcsCalendar(assignments = null) {
    const items = assignments || getCombinedAssignments().filter((a) => a.is_active_context && !a.is_archived_context);
    if (!items || items.length === 0) {
      showToast('No active deadlines to export.');
      return;
    }

    const formatIcsDate = (date) => {
      const d = new Date(date);
      return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const nowIso = formatIcsDate(new Date());

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Slated//School Dashboard v4.0//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Slated Schedule & Deadlines',
      'X-WR-TIMEZONE:America/New_York',
    ];

    items.forEach((a) => {
      const due = a.effective_due_at || a.due_at;
      if (!due) return;
      const dueDate = new Date(due);
      const startDate = new Date(dueDate.getTime() - 45 * 60 * 1000);
      const uid = `slated-${a.id}-${dueDate.getTime()}@slated.app`;
      const course = getCourseById(a.course_id);
      const meta = course ? parseCourseMeta(course) : { period: '', title: '' };
      const summary = `${meta.period ? meta.period + ' · ' : ''}${a.name}`.replace(/[\r\n]+/g, ' ');
      const desc = `Class: ${meta.title || 'Course'}\\nPoints: ${a.points_possible || 'N/A'}\\nDetails: ${stripHtml(a.description || '').slice(0, 160)}`.replace(/[\r\n]+/g, '\\n');
      const location = (meta.title || (course ? course.name : 'School')).replace(/[\r\n]+/g, ' ');

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${nowIso}`);
      lines.push(`DTSTART:${formatIcsDate(startDate)}`);
      lines.push(`DTEND:${formatIcsDate(dueDate)}`);
      lines.push(`SUMMARY:${summary}`);
      lines.push(`DESCRIPTION:${desc}`);
      lines.push(`LOCATION:${location}`);
      lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
    });

    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'slated-deadlines.ics';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Downloaded slated-deadlines.ics');
  }

  function openGcalSyncModal() {
    if (!els.gcalSyncModalBackdrop) return;
    let feedUrl = `${window.location.origin}/api/calendar.ics`;
    const firstWithIcs = state.courses.find((c) => c.calendar && c.calendar.ics);
    if (firstWithIcs && firstWithIcs.calendar.ics) {
      feedUrl = firstWithIcs.calendar.ics;
    }
    if (els.gcalFeedUrlInput) {
      els.gcalFeedUrlInput.value = feedUrl;
    }
    els.gcalSyncModalBackdrop.classList.remove('hidden');
  }

  function closeGcalSyncModal() {
    if (els.gcalSyncModalBackdrop) {
      els.gcalSyncModalBackdrop.classList.add('hidden');
    }
  }

  // -------------------------------------------------------------------------
  // 11c. Direct In-App Canvas Assignment Submissions
  // -------------------------------------------------------------------------
  function switchSubmissionTab(tab) {
    const tabs = ['url', 'file', 'text'];
    tabs.forEach((t) => {
      const btn = t === 'url' ? els.submitTabUrlBtn : t === 'file' ? els.submitTabFileBtn : els.submitTabTextBtn;
      const form = t === 'url' ? els.submissionUrlForm : t === 'file' ? els.submissionFileForm : els.submissionTextForm;
      if (btn && form) {
        if (t === tab) {
          btn.classList.add('studio-btn-primary');
          btn.classList.remove('tone-surface');
          form.classList.remove('hidden');
        } else {
          btn.classList.remove('studio-btn-primary');
          btn.classList.add('tone-surface');
          form.classList.add('hidden');
        }
      }
    });
  }

  function openSubmissionModal(assignmentId, courseId) {
    const combined = getCombinedAssignments();
    const assignment = combined.find((a) => String(a.id) === String(assignmentId));
    if (!assignment) return;
    const cid = String(courseId || assignment.course_id);
    const course = getCourseById(cid);
    const meta = course ? parseCourseMeta(course) : { title: 'Course', period: '' };

    state.activeSubmission = {
      assignmentId: String(assignment.id),
      courseId: cid,
      assignment,
    };

    if (els.submitCourseBadge) els.submitCourseBadge.textContent = meta.title || 'Course';
    if (els.submitPointsBadge) els.submitPointsBadge.textContent = assignment.points_possible != null ? `${assignment.points_possible} pts` : 'Ungraded';
    if (els.submitAssignmentTitle) els.submitAssignmentTitle.textContent = assignment.name;
    if (els.submitDueBadge) els.submitDueBadge.textContent = `Due ${formatDateTime(assignment.effective_due_at || assignment.due_at)}`;

    const canvasUrl =
      safeHttpUrl(
        assignment.html_url || `${state.canvasBaseUrl}/courses/${cid}/assignments/${assignment.id}`
      ) || '#';
    if (els.submissionCanvasDirectLink) els.submissionCanvasDirectLink.href = canvasUrl;
    if (els.submissionCanvasDirectLink2) els.submissionCanvasDirectLink2.href = canvasUrl;
    if (els.submissionCanvasDirectLink3) els.submissionCanvasDirectLink3.href = canvasUrl;

    if (els.submissionErrorNotice) els.submissionErrorNotice.classList.add('hidden');
    if (els.submissionFileErrorNotice) els.submissionFileErrorNotice.classList.add('hidden');
    if (els.submissionTextErrorNotice) els.submissionTextErrorNotice.classList.add('hidden');
    if (els.submissionUrlInput) els.submissionUrlInput.value = '';
    if (els.submissionFileInput) els.submissionFileInput.value = '';
    if (els.submissionTextInput) els.submissionTextInput.value = '';

    switchSubmissionTab('url');

    if (els.submissionModalBackdrop) {
      els.submissionModalBackdrop.classList.remove('hidden');
    }
  }

  function closeSubmissionModal() {
    if (els.submissionModalBackdrop) {
      els.submissionModalBackdrop.classList.add('hidden');
    }
    state.activeSubmission = null;
  }

  async function submitAssignmentPayload(payload, errorEl, submitBtn, defaultBtnText) {
    if (!state.activeSubmission) return;
    const { courseId, assignmentId } = state.activeSubmission;

    if (errorEl) errorEl.classList.add('hidden');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting to Canvas...';
    }

    try {
      if (state.cloudStaticMode) {
        throw new Error('Direct submission requires the local/cloud Node API. Please open Canvas directly or connect local backend.');
      }

      const res = await apiFetch(`/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions`, {
        method: 'POST',
        body: payload,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `Canvas submission failed (HTTP ${res.status})`);
      }

      playSuccessChime();
      launchConfetti();
      state.checkedIds.add(String(assignmentId));
      setStoredItem('localStorage', 'atelier_checked_ids', JSON.stringify(Array.from(state.checkedIds)));

      closeSubmissionModal();
      showToast('Successfully turned in to Canvas! Nice work.');
      renderAll();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Submission failed. Please check your input or open in Canvas.';
        errorEl.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = defaultBtnText;
      }
    }
  }

  function updateCommandKeyLabels() {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
    const badgeText = isMac ? '⌘K' : 'Ctrl+K';
    if (els.cmdPaletteKeyBadge) {
      els.cmdPaletteKeyBadge.textContent = badgeText;
    }
    if (els.searchInput) {
      els.searchInput.placeholder = `Search assignments, modules, or teachers (${badgeText} or /)...`;
    }
  }

  // -------------------------------------------------------------------------
  // 12. Event Listeners & Keyboard Shortcuts
  // -------------------------------------------------------------------------

  function openStudyLabDrawer(deckId = 'calc_log', idx = 0) {
    if (els.studyLabDrawerBackdrop) els.studyLabDrawerBackdrop.classList.remove('hidden');
    openStudyLabDeck(deckId, idx);
  }
  function closeStudyLabDrawer() {
    if (els.studyLabDrawerBackdrop) els.studyLabDrawerBackdrop.classList.add('hidden');
  }

  function openBriefingsDrawer(tab = 'all') {
    state.briefingTab = tab;
    if (tab === 'saved') {
      renderSavedBriefingsDrawer();
      if (els.briefingsAllView) els.briefingsAllView.classList.add('hidden');
      if (els.briefingsSavedView) els.briefingsSavedView.classList.remove('hidden');
      if (els.briefingTabSavedBtn) {
        els.briefingTabSavedBtn.classList.add('studio-btn-primary');
        els.briefingTabSavedBtn.classList.remove('tone-surface');
      }
      if (els.briefingTabAllBtn) {
        els.briefingTabAllBtn.classList.remove('studio-btn-primary');
        els.briefingTabAllBtn.classList.add('tone-surface');
      }
    } else {
      if (els.briefingsAllView) els.briefingsAllView.classList.remove('hidden');
      if (els.briefingsSavedView) els.briefingsSavedView.classList.add('hidden');
      if (els.briefingTabAllBtn) {
        els.briefingTabAllBtn.classList.add('studio-btn-primary');
        els.briefingTabAllBtn.classList.remove('tone-surface');
      }
      if (els.briefingTabSavedBtn) {
        els.briefingTabSavedBtn.classList.remove('studio-btn-primary');
        els.briefingTabSavedBtn.classList.add('tone-surface');
      }
    }
    if (els.briefingsDrawerBackdrop) els.briefingsDrawerBackdrop.classList.remove('hidden');
  }
  function closeBriefingsDrawer() {
    if (els.briefingsDrawerBackdrop) els.briefingsDrawerBackdrop.classList.add('hidden');
  }

  function openResourcesDrawer() {
    state.resourcePage = 1;
    state.resourcesPage = 1;
    renderResourcesVault();
    if (els.resourcesDrawerBackdrop) {
      els.resourcesDrawerBackdrop.classList.remove('hidden');
      els.resourcesDrawerBackdrop.setAttribute('aria-hidden', 'false');
    }
  }
  function closeResourcesDrawer() {
    if (els.resourcesDrawerBackdrop) {
      els.resourcesDrawerBackdrop.classList.add('hidden');
      els.resourcesDrawerBackdrop.setAttribute('aria-hidden', 'true');
    }
  }

  function openPacingDrawer() {
    renderPacingTimeline();
    if (els.pacingDrawerBackdrop) els.pacingDrawerBackdrop.classList.remove('hidden');
  }
  function closePacingDrawer() {
    if (els.pacingDrawerBackdrop) els.pacingDrawerBackdrop.classList.add('hidden');
  }

  function openCalendarDrawer() {
    renderCalendar(getCombinedAssignments());
    if (els.calendarDrawerBackdrop) els.calendarDrawerBackdrop.classList.remove('hidden');
  }
  function closeCalendarDrawer() {
    if (els.calendarDrawerBackdrop) els.calendarDrawerBackdrop.classList.add('hidden');
  }

  function closeAllDrawers() {
    closeCmdPalette();
    closeCourseInspector();
    closeTokenModal();
    closeSubmissionModal();
    closeGcalSyncModal();
    closeStudyLabDrawer();
    closeBriefingsDrawer();
    closeResourcesDrawer();
    closePacingDrawer();
    closeCalendarDrawer();
    if (els.privacyModalBackdrop) els.privacyModalBackdrop.classList.add('hidden');
  }

  async function copyIcalFeedUrl() {
    let feedUrl = `${window.location.origin}/api/calendar.ics`;
    const firstWithIcs = state.courses.find((c) => c.calendar && c.calendar.ics);
    if (firstWithIcs && firstWithIcs.calendar.ics) {
      feedUrl = firstWithIcs.calendar.ics;
    }
    try {
      await navigator.clipboard.writeText(feedUrl);
      showToast('Copied iCal feed link for Google / Apple Calendar.');
    } catch (_) {
      window.prompt('Copy this iCal URL:', feedUrl);
    }
  }

  function launchDemoMode() {
    state.isDemoMode = true;
    state.authenticated = true;
    state.credentials = {
      configured: true,
      canvasBaseUrl: 'https://wcpss.instructure.com',
      maskedToken: 'DEMO~SAMPLE...MODE',
    };
    state.canvasBaseUrl = 'https://wcpss.instructure.com';
    state.studentName = SAMPLE_STUDENT_DATA.studentName;
    state.courses = JSON.parse(JSON.stringify(SAMPLE_STUDENT_DATA.courses));
    state.assignments = JSON.parse(JSON.stringify(SAMPLE_STUDENT_DATA.assignments));
    state.announcements = JSON.parse(JSON.stringify(SAMPLE_STUDENT_DATA.announcements));
    state.resources = JSON.parse(JSON.stringify(SAMPLE_STUDENT_DATA.resources));
    state.courseContexts = JSON.parse(JSON.stringify(SAMPLE_STUDENT_DATA.courseContexts));
    state.pacingCalendar = JSON.parse(JSON.stringify(SAMPLE_STUDENT_DATA.pacingCalendar));

    const demoBanner = document.getElementById('demoModeBanner');
    if (demoBanner) demoBanner.classList.remove('hidden');

    if (els.authGateSection) els.authGateSection.classList.add('hidden');
    if (els.dashboardMain) els.dashboardMain.classList.remove('hidden');

    renderCourseSelectors();
    renderAll();
    triggerRevealAnimations();
    showToast('Loaded Slated Interactive Demo Mode! Feel free to test any feature.');
  }

  function exitDemoMode() {
    state.isDemoMode = false;
    state.authenticated = false;
    const demoBanner = document.getElementById('demoModeBanner');
    if (demoBanner) demoBanner.classList.add('hidden');
    if (els.authGateSection) els.authGateSection.classList.remove('hidden');
    if (els.dashboardMain) els.dashboardMain.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const tokenInp = document.getElementById('quickTokenInput');
    if (tokenInp) tokenInp.focus();
  }

  function bindEvents() {
    applyPalette(state.palette);
    renderSavedGoogleBox();
    updateCommandKeyLabels();

    if (els.customTaskDue) {
      els.customTaskDue.value = new Date(Date.now() + 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
    }

    // Palette Switcher Buttons
    document.querySelectorAll('.palette-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-set-palette');
        applyPalette(p);
      });
    });

    // Global Keyboard Shortcuts (Cmd+K / Ctrl+K for Command Palette, Escape to close modals, / to search)
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (state.authenticated && state.credentials.configured) {
          e.preventDefault();
          openCmdPalette();
        }
      } else if (e.key === 'Escape') {
        closeAllDrawers();
      } else if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        if (state.authenticated && els.searchInput) {
          e.preventDefault();
          els.searchInput.focus();
          els.searchInput.select();
        }
      }
    });

    if (els.openCmdPaletteBtn) els.openCmdPaletteBtn.addEventListener('click', openCmdPalette);
    if (els.footerCmdBtn) els.footerCmdBtn.addEventListener('click', openCmdPalette);
    if (els.closeCmdPaletteBtn) els.closeCmdPaletteBtn.addEventListener('click', closeCmdPalette);
    if (els.cmdPaletteBackdrop) {
      els.cmdPaletteBackdrop.addEventListener('click', (e) => {
        if (e.target === els.cmdPaletteBackdrop) closeCmdPalette();
      });
    }
    if (els.cmdPaletteInput) {
      els.cmdPaletteInput.addEventListener('input', (e) => {
        renderCmdPaletteResults(e.target.value);
      });
      els.cmdPaletteInput.addEventListener('keydown', (e) => {
        const resultButtons = els.cmdPaletteResults.querySelectorAll('[data-cmd-idx]');
        const total = resultButtons.length;
        if (total === 0) return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          state.cmdPaletteSelectedIndex = (state.cmdPaletteSelectedIndex + 1) % total;
          resultButtons.forEach((b, i) => {
            b.classList.toggle('cmd-item-active', i === state.cmdPaletteSelectedIndex);
          });
          const sel = resultButtons[state.cmdPaletteSelectedIndex];
          if (sel) sel.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          state.cmdPaletteSelectedIndex = (state.cmdPaletteSelectedIndex - 1 + total) % total;
          resultButtons.forEach((b, i) => {
            b.classList.toggle('cmd-item-active', i === state.cmdPaletteSelectedIndex);
          });
          const sel = resultButtons[state.cmdPaletteSelectedIndex];
          if (sel) sel.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const sel = resultButtons[state.cmdPaletteSelectedIndex];
          if (sel) sel.click();
        }
      });
    }

    // Privacy & Security Proof Modal
    const openPrivacyModal = () => {
      renderSecurityAuditModal();
      if (els.privacyModalBackdrop) els.privacyModalBackdrop.classList.remove('hidden');
    };
    if (els.openPrivacyModalBtn) els.openPrivacyModalBtn.addEventListener('click', openPrivacyModal);
    if (els.heroInspectSecurityBtn) els.heroInspectSecurityBtn.addEventListener('click', openPrivacyModal);
    if (els.footerSecurityBtn) els.footerSecurityBtn.addEventListener('click', openPrivacyModal);
    if (els.closePrivacyModalBtn) {
      els.closePrivacyModalBtn.addEventListener('click', () =>
        els.privacyModalBackdrop.classList.add('hidden')
      );
    }
    if (els.donePrivacyModalBtn) {
      els.donePrivacyModalBtn.addEventListener('click', () =>
        els.privacyModalBackdrop.classList.add('hidden')
      );
    }
    if (els.privacyModalBackdrop) {
      els.privacyModalBackdrop.addEventListener('click', (e) => {
        if (e.target === els.privacyModalBackdrop) {
          els.privacyModalBackdrop.classList.add('hidden');
        }
      });
    }

    // Instant Panic Wipe Button
    if (els.panicWipeBtn) {
      els.panicWipeBtn.addEventListener('click', async () => {
        let localDataCleared = true;
        const localKeys = [
          'slated_google_vault_enc',
          'slated_google_profile_meta',
          'slated_device_key_v1',
          'atelier_custom_tasks',
          'atelier_checked_ids',
          'slated_inclass_retakes',
          'slated_packed_supplies',
          'atelier_saved_briefings',
          'slated_pinned_announcements',
          TOKEN_LIFECYCLE_KEY,
          'slated_schedule_config',
          'slated_offline_cache_v2',
          'slated_palette',
          'slated_sound_muted',
          'slated_compact_view',
        ];
        for (const key of localKeys) {
          if (!removeStoredItem('localStorage', key)) localDataCleared = false;
        }
        if (!removeStoredItem('sessionStorage', 'atelier_active_token_session')) {
          localDataCleared = false;
        }

        let remoteDataCleared = state.cloudStaticMode ? null : true;
        if (!state.cloudStaticMode) {
          remoteDataCleared = true;
          for (const [url, options] of [
            ['/api/user/credentials', { method: 'DELETE' }],
            ['/api/auth/logout', { method: 'POST' }],
          ]) {
            try {
              const response = await apiFetch(url, options);
              if (!response.ok) remoteDataCleared = false;
            } catch (error) {
              remoteDataCleared = false;
              console.warn(`Could not clear server data through ${url}:`, error);
            }
          }
        }

        browserRamCreds = null;
        unlockedSnapshotData = null;
        state.authenticated = false;
        state.courses = [];
        state.assignments = [];
        state.announcements = [];
        state.courseContexts = {};
        state.resources = [];
        state.pacingCalendar = null;
        state.customTasks = [];
        state.checkedIds.clear();
        state.inClassRetakeIds.clear();
        state.packedSupplyIds.clear();
        state.savedBriefingIds.clear();
        state.pinnedAnnouncementIds.clear();
        state.whatIfScores = {};
        state.whatIfCustomTests = [];
        state.targetGradeInputs = {};
        if (state.studyLab) {
          state.studyLab.typedInput = '';
          state.studyLab.customTargetExpr =
            '(x^2+1)^sin(x) * (cos(x)*ln(x^2+1) + (2*x*sin(x))/(x^2+1))';
          state.studyLab.customOrigYExpr = '(x^2+1)^sin(x)';
          state.studyLab.inputMode = 'type';
          state.studyLab.showSteps = false;
          state.studyLab.uploadedImageMeta = null;
          state.studyLab.uploadedImageDataUrl = null;
          state.studyLab.scratchpadStrokes = [];
          state.studyLab.lastVerification = null;
        }
        els.privacyModalBackdrop.classList.add('hidden');
        const wipeConfirmed = localDataCleared && remoteDataCleared !== false;
        showToast(
          wipeConfirmed
            ? remoteDataCleared === null
              ? 'Local data cleared.'
              : 'Local data cleared; server credentials and session removed.'
            : 'Some data could not be confirmed as cleared. Check your connection and try again.'
        );
        await updateViewForAuthState();
      });
    }

    // Zero-Config Google Sign-In Controls
    if (els.continueSavedGoogleBtn) {
      els.continueSavedGoogleBtn.addEventListener('click', async () => {
        els.continueSavedGoogleBtn.disabled = true;
        els.continueSavedGoogleBtn.textContent = 'Signing in...';
        try {
          const vault = await loadEncryptedGoogleVault();
          if (!vault || !vault.canvasApiToken) {
            throw new Error('Saved vault expired. Please paste your token below.');
          }
          await connectWithTokenPayload({
            rawToken: vault.canvasApiToken,
            rawUrl: vault.canvasBaseUrl,
            googleEmail: vault.googleEmail,
            displayName: vault.displayName,
          });
        } catch (err) {
          els.quickConnectError.textContent = err.message;
          els.quickConnectError.classList.remove('hidden');
        } finally {
          els.continueSavedGoogleBtn.disabled = false;
          renderSavedGoogleBox();
        }
      });
    }

    if (els.googleSignInTriggerBtn) {
      els.googleSignInTriggerBtn.addEventListener('click', async () => {
        const vault = await loadEncryptedGoogleVault();
        if (vault && vault.canvasApiToken) {
          await connectWithTokenPayload({
            rawToken: vault.canvasApiToken,
            rawUrl: vault.canvasBaseUrl,
            googleEmail: vault.googleEmail,
            displayName: vault.displayName,
          });
          return;
        }
        if (els.googleIdentityDrawer) {
          els.googleIdentityDrawer.classList.toggle('hidden');
          if (!els.googleIdentityDrawer.classList.contains('hidden')) {
            els.googleEmailInput.focus();
          }
        }
      });
    }

    // District Preset URL Buttons
    document.querySelectorAll('[data-preset-url]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-preset-url');
        if (els.quickBaseUrlInput && url) {
          els.quickBaseUrlInput.value = url;
          if (els.helperCanvasSettingsLink) {
            els.helperCanvasSettingsLink.href = safeHttpUrl(`${url}/profile/settings`) || '#';
          }
        }
      });
    });


    // Demo Mode Buttons (Frictionless exploration without requiring a token upfront)
    const heroDemoBtn = document.getElementById('heroExploreDemoBtn');
    if (heroDemoBtn) heroDemoBtn.addEventListener('click', launchDemoMode);

    const quickDemoBtn = document.getElementById('quickDemoBtn');
    if (quickDemoBtn) quickDemoBtn.addEventListener('click', launchDemoMode);

    const demoRealBtn = document.getElementById('demoConnectRealBtn');
    if (demoRealBtn) demoRealBtn.addEventListener('click', exitDemoMode);

    // Tools Hub Quick Action Cards
    if (els.hubOpenStudyLabBtn) els.hubOpenStudyLabBtn.addEventListener('click', () => openStudyLabDrawer('calc_log', 0));
    if (els.hubOpenBriefingsBtn) els.hubOpenBriefingsBtn.addEventListener('click', () => openBriefingsDrawer('all'));
    if (els.hubOpenResourcesBtn) els.hubOpenResourcesBtn.addEventListener('click', openResourcesDrawer);
    if (els.hubOpenPacingBtn) els.hubOpenPacingBtn.addEventListener('click', openPacingDrawer);

    // Header Section Nav Links
    if (els.navStudyLabBtn) {
      els.navStudyLabBtn.addEventListener('click', () => {
        if (!state.authenticated) launchDemoMode();
        openStudyLabDrawer('calc_log', 0);
      });
    }
    if (els.navBriefingsBtn) {
      els.navBriefingsBtn.addEventListener('click', () => {
        if (!state.authenticated) launchDemoMode();
        openBriefingsDrawer('all');
      });
    }
    if (els.navResourcesBtn) {
      els.navResourcesBtn.addEventListener('click', () => {
        if (!state.authenticated) launchDemoMode();
        openResourcesDrawer();
      });
    }
    if (els.navCalendarBtn) {
      els.navCalendarBtn.addEventListener('click', () => {
        if (!state.authenticated) launchDemoMode();
        openCalendarDrawer();
      });
    }

    // Drawer Close Buttons & Backdrop Click
    if (els.closeStudyLabDrawerBtn) els.closeStudyLabDrawerBtn.addEventListener('click', closeStudyLabDrawer);
    if (els.studyLabDrawerBackdrop) {
      els.studyLabDrawerBackdrop.addEventListener('click', (e) => {
        if (e.target === els.studyLabDrawerBackdrop) closeStudyLabDrawer();
      });
    }

    if (els.closeResourcesDrawerBtn) els.closeResourcesDrawerBtn.addEventListener('click', closeResourcesDrawer);
    if (els.resourcesDrawerBackdrop) {
      els.resourcesDrawerBackdrop.addEventListener('click', (e) => {
        if (e.target === els.resourcesDrawerBackdrop) closeResourcesDrawer();
      });
    }

    if (els.closePacingDrawerBtn) els.closePacingDrawerBtn.addEventListener('click', closePacingDrawer);
    if (els.pacingDrawerBackdrop) {
      els.pacingDrawerBackdrop.addEventListener('click', (e) => {
        if (e.target === els.pacingDrawerBackdrop) closePacingDrawer();
      });
    }

    if (els.closeCalendarDrawerBtn) els.closeCalendarDrawerBtn.addEventListener('click', closeCalendarDrawer);
    if (els.calendarDrawerBackdrop) {
      els.calendarDrawerBackdrop.addEventListener('click', (e) => {
        if (e.target === els.calendarDrawerBackdrop) closeCalendarDrawer();
      });
    }
    if (els.drawerDownloadIcsBtn) els.drawerDownloadIcsBtn.addEventListener('click', () => downloadIcsCalendar());

    // Briefings Drawer Tabs (All vs Saved Vault)
    if (els.briefingTabAllBtn) els.briefingTabAllBtn.addEventListener('click', () => openBriefingsDrawer('all'));
    if (els.briefingTabSavedBtn) els.briefingTabSavedBtn.addEventListener('click', () => openBriefingsDrawer('saved'));

    // Saved Briefings Drawer Controls
    if (els.openBriefingsDrawerBtn) {
      els.openBriefingsDrawerBtn.addEventListener('click', () => {
        renderSavedBriefingsDrawer();
        els.briefingsDrawerBackdrop.classList.remove('hidden');
      });
    }
    if (els.closeBriefingsDrawerBtn) {
      els.closeBriefingsDrawerBtn.addEventListener('click', () => {
        els.briefingsDrawerBackdrop.classList.add('hidden');
      });
    }
    if (els.briefingsDrawerBackdrop) {
      els.briefingsDrawerBackdrop.addEventListener('click', (e) => {
        if (e.target === els.briefingsDrawerBackdrop) {
          els.briefingsDrawerBackdrop.classList.add('hidden');
        }
      });
    }

    // Course Inspector & Grade Lab Drawer Controls
    if (els.closeCourseInspectorBtn) {
      els.closeCourseInspectorBtn.addEventListener('click', closeCourseInspector);
    }
    if (els.courseInspectorBackdrop) {
      els.courseInspectorBackdrop.addEventListener('click', (e) => {
        if (e.target === els.courseInspectorBackdrop) {
          closeCourseInspector();
        }
      });
    }
    document.querySelectorAll('.inspector-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.inspectorTab = btn.getAttribute('data-inspector-tab') || 'overview';
        renderCourseInspector();
      });
    });

    // Study & Answer Equivalence Lab Deck Tabs
    document.querySelectorAll('.study-deck-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const deckId = btn.getAttribute('data-study-deck') || 'calc_log';
        openStudyLabDeck(deckId, 0);
      });
    });

    // Announcement Filter Pills
    document.querySelectorAll('.ann-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.announcementFilter = btn.getAttribute('data-ann-filter') || 'all';
        document.querySelectorAll('.ann-filter-btn').forEach((b) => {
          b.classList.toggle('studio-btn-primary', b === btn);
        });
        renderAll();
      });
    });

    if (els.quickBaseUrlInput && els.helperCanvasSettingsLink) {
      els.quickBaseUrlInput.addEventListener('input', () => {
        const clean = els.quickBaseUrlInput.value
          .trim()
          .replace(/^(https?):\/([^/])/i, '$1://$2')
          .replace(/\/+$/, '');
        if (clean.startsWith('https://')) {
          els.helperCanvasSettingsLink.href = safeHttpUrl(`${clean}/profile/settings`) || '#';
        }
      });
    }

    if (els.quickConnectForm) {
      els.quickConnectForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        els.quickConnectError.classList.add('hidden');
        els.quickConnectSubmitBtn.disabled = true;
        els.quickConnectSubmitBtn.textContent = 'Connecting...';
        try {
          await connectWithTokenPayload({
            rawToken: els.quickTokenInput.value,
            rawUrl: els.quickBaseUrlInput.value,
            googleEmail: els.googleEmailInput ? els.googleEmailInput.value.trim() : '',
            displayName: els.googleDisplayNameInput ? els.googleDisplayNameInput.value.trim() : '',
          });
          els.quickTokenInput.value = '';
        } catch (err) {
          els.quickConnectError.textContent = err.message;
          els.quickConnectError.classList.remove('hidden');
        } finally {
          els.quickConnectSubmitBtn.disabled = false;
          els.quickConnectSubmitBtn.textContent = 'Launch Slated';
        }
      });
    }

    if (els.quickEnvFileInput) {
      els.quickEnvFileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        els.quickConnectError.classList.add('hidden');
        els.quickConnectSubmitBtn.disabled = true;
        els.quickConnectSubmitBtn.textContent = 'Importing .env...';
        try {
          const text = await file.text();
          await connectWithTokenPayload({
            envFileContent: text,
            googleEmail: els.googleEmailInput ? els.googleEmailInput.value.trim() : '',
            displayName: els.googleDisplayNameInput ? els.googleDisplayNameInput.value.trim() : '',
          });
        } catch (err) {
          els.quickConnectError.textContent = err.message;
          els.quickConnectError.classList.remove('hidden');
        } finally {
          els.quickConnectSubmitBtn.disabled = false;
          els.quickConnectSubmitBtn.textContent = 'Launch Slated';
          els.quickEnvFileInput.value = '';
        }
      });
    }

    if (els.quickLocalEnvBtn) {
      els.quickLocalEnvBtn.addEventListener('click', async () => {
        els.quickConnectError.classList.add('hidden');
        try {
          await connectWithTokenPayload({ importWorkspaceEnv: true });
        } catch (err) {
          els.quickConnectError.textContent = err.message;
          els.quickConnectError.classList.remove('hidden');
        }
      });
    }

    if (els.logoutBtn) {
      els.logoutBtn.addEventListener('click', async () => {
        removeStoredItem('sessionStorage', 'atelier_active_token_session');
        browserRamCreds = null;
        unlockedSnapshotData = null;
        if (!state.cloudStaticMode) {
          await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        }
        state.authenticated = false;
        state.courses = [];
        state.assignments = [];
        state.announcements = [];
        showToast('Session locked. Click Continue with Google anytime to unlock.');
        await updateViewForAuthState();
      });
    }

    if (els.openTokenModalBtn) els.openTokenModalBtn.addEventListener('click', openTokenModal);
    if (els.closeTokenModalBtn) els.closeTokenModalBtn.addEventListener('click', closeTokenModal);
    if (els.cancelTokenModalBtn) els.cancelTokenModalBtn.addEventListener('click', closeTokenModal);

    // Token lifecycle controls
    const expiryChip = document.getElementById('tokenExpiryChip');
    if (expiryChip) expiryChip.addEventListener('click', openTokenModal);
    const expiryDateInput = document.getElementById('tokenExpiryDateInput');
    if (expiryDateInput) {
      expiryDateInput.addEventListener('change', () => {
        const lc = getTokenLifecycle();
        if (!lc || !expiryDateInput.value) return;
        const picked = new Date(`${expiryDateInput.value}T23:59:00`);
        if (Number.isNaN(picked.getTime())) return;
        lc.expiresAt = picked.toISOString();
        lc.expirySource = 'user';
        saveTokenLifecycle(lc);
        renderTokenLifecycleUI();
        showToast(`Expiry set to ${picked.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`);
      });
    }
    const autoWipeToggle = document.getElementById('tokenAutoWipeToggle');
    if (autoWipeToggle) {
      autoWipeToggle.addEventListener('change', () => {
        const lc = getTokenLifecycle();
        if (!lc) return;
        lc.autoWipe = autoWipeToggle.checked;
        saveTokenLifecycle(lc);
      });
    }
    // Re-check hourly so a session left open past expiry locks itself
    setInterval(() => {
      if (enforceTokenExpiry()) {
        state.authenticated = false;
        updateViewForAuthState();
      } else {
        renderTokenLifecycleUI();
      }
    }, 60 * 60 * 1000);

    if (els.envFileInput) {
      els.envFileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        els.tokenFormError.classList.add('hidden');
        els.saveTokenSubmitBtn.disabled = true;
        els.saveTokenSubmitBtn.textContent = 'Importing...';
        try {
          const text = await file.text();
          await connectWithTokenPayload({
            envFileContent: text,
            googleEmail: els.modalGoogleEmailInput ? els.modalGoogleEmailInput.value.trim() : '',
          });
          closeTokenModal();
        } catch (err) {
          els.tokenFormError.textContent = err.message;
          els.tokenFormError.classList.remove('hidden');
        } finally {
          els.saveTokenSubmitBtn.disabled = false;
          els.saveTokenSubmitBtn.textContent = 'Save & Sync';
          els.envFileInput.value = '';
        }
      });
    }

    if (els.credentialsForm) {
      els.credentialsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        els.tokenFormError.classList.add('hidden');
        els.saveTokenSubmitBtn.disabled = true;
        els.saveTokenSubmitBtn.textContent = 'Saving...';
        try {
          await connectWithTokenPayload({
            rawToken: els.canvasApiTokenInput.value,
            rawUrl: els.canvasBaseUrlInput.value,
            googleEmail: els.modalGoogleEmailInput ? els.modalGoogleEmailInput.value.trim() : '',
          });
          els.canvasApiTokenInput.value = '';
          closeTokenModal();
        } catch (err) {
          els.tokenFormError.textContent = err.message;
          els.tokenFormError.classList.remove('hidden');
        } finally {
          els.saveTokenSubmitBtn.disabled = false;
          els.saveTokenSubmitBtn.textContent = 'Save & Sync';
        }
      });
    }

    if (els.deleteTokenBtn) {
      els.deleteTokenBtn.addEventListener('click', async () => {
        sessionStorage.removeItem('atelier_active_token_session');
        removeStoredItem('localStorage', 'slated_google_vault_enc');
        removeStoredItem('localStorage', 'slated_google_profile_meta');
        removeStoredItem('localStorage', TOKEN_LIFECYCLE_KEY);
        browserRamCreds = null;
        unlockedSnapshotData = null;
        if (!state.cloudStaticMode) {
          await apiFetch('/api/user/credentials', { method: 'DELETE' }).catch(() => {});
          await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        }
        state.authenticated = false;
        state.courses = [];
        state.assignments = [];
        state.announcements = [];
        closeTokenModal();
        showToast('Wiped token and saved Google vault.');
        await updateViewForAuthState();
      });
    }

    if (els.customTaskForm) {
      els.customTaskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = els.customTaskTitle.value.trim();
        if (!title) return;
        const courseId = els.customTaskCourse.value || 'custom';
        const dueDateStr = els.customTaskDue.value;
        const dueIso = dueDateStr
          ? new Date(`${dueDateStr}T23:59:00`).toISOString()
          : new Date(Date.now() + 86400000).toISOString();

        state.customTasks.unshift({
          id: `custom_${Date.now()}`,
          course_id: courseId,
          name: title,
          due_at: dueIso,
        });
        setStoredItem('localStorage', 'atelier_custom_tasks', JSON.stringify(state.customTasks));
        els.customTaskTitle.value = '';
        showToast(`Added "${title}" to your queue.`);
        renderAll();
      });
    }

    if (els.startQuickFocusBtn) {
      els.startQuickFocusBtn.addEventListener('click', () => {
        startFocusTimer('25m Study Session');
      });
    }
    if (els.focusTimerToggleBtn) {
      els.focusTimerToggleBtn.addEventListener('click', () => {
        state.focusTimer.paused = !state.focusTimer.paused;
        updateFocusTimerDisplay();
      });
    }
    if (els.focusTimerStopBtn) {
      els.focusTimerStopBtn.addEventListener('click', () => {
        clearInterval(state.focusTimer.intervalId);
        state.focusTimer.active = false;
        updateFocusTimerDisplay();
      });
    }

    document.querySelectorAll('.horizon-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setAssignmentHorizon(btn.getAttribute('data-horizon') || 'all');
      });
    });

    if (els.searchInput) {
      els.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim();
        if (els.resetCourseFilterBtn) {
          els.resetCourseFilterBtn.classList.toggle(
            'hidden',
            state.selectedCourseId === 'all' && !state.searchQuery
          );
        }
        renderAll();
      });
    }

    if (els.courseFilterSelect) {
      els.courseFilterSelect.addEventListener('change', (e) => {
        state.selectedCourseId = e.target.value;
        if (els.resetCourseFilterBtn) {
          els.resetCourseFilterBtn.classList.toggle(
            'hidden',
            state.selectedCourseId === 'all' && !state.searchQuery
          );
        }
        renderAll();
      });
    }

    if (els.resetCourseFilterBtn) {
      els.resetCourseFilterBtn.addEventListener('click', () => {
        state.selectedCourseId = 'all';
        state.searchQuery = '';
        if (els.searchInput) els.searchInput.value = '';
        renderCourseSelectors();
        renderAll();
      });
    }

    if (els.copyIcalBtn) {
      els.copyIcalBtn.addEventListener('click', async () => {
        let icalUrl = `${window.location.origin}/api/calendar.ics`;
        if (state.selectedCourseId !== 'all') {
          const course = getCourseById(state.selectedCourseId);
          if (course && course.calendar && course.calendar.ics) {
            icalUrl = course.calendar.ics;
          }
        } else {
          const firstWithIcs = state.courses.find((c) => c.calendar && c.calendar.ics);
          if (firstWithIcs && firstWithIcs.calendar.ics) {
            icalUrl = firstWithIcs.calendar.ics;
          }
        }

        try {
          await navigator.clipboard.writeText(icalUrl);
          showToast('Copied iCal feed link for Google Calendar.');
        } catch (_) {
          window.prompt('Copy this iCal URL for Google Calendar:', icalUrl);
        }
      });
    }

    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', () => {
        loadDashboardData(true);
        showToast('Syncing fresh Canvas data...');
      });
    }

    if (els.prevMonthBtn) {
      els.prevMonthBtn.addEventListener('click', () => {
        state.calendarDate = new Date(
          state.calendarDate.getFullYear(),
          state.calendarDate.getMonth() - 1,
          1
        );
        renderAll();
      });
    }

    if (els.nextMonthBtn) {
      els.nextMonthBtn.addEventListener('click', () => {
        state.calendarDate = new Date(
          state.calendarDate.getFullYear(),
          state.calendarDate.getMonth() + 1,
          1
        );
        renderAll();
      });
    }

    if (els.todayMonthBtn) {
      els.todayMonthBtn.addEventListener('click', () => {
        const now = new Date();
        state.calendarDate = new Date(now.getFullYear(), now.getMonth(), 1);
        renderAll();
      });
    }

    // Google Calendar & .ics Sync Event Listeners
    if (els.openGcalSyncBtn) els.openGcalSyncBtn.addEventListener('click', openGcalSyncModal);
    if (els.closeGcalSyncModalBtn) els.closeGcalSyncModalBtn.addEventListener('click', closeGcalSyncModal);
    if (els.gcalSyncModalBackdrop) {
      els.gcalSyncModalBackdrop.addEventListener('click', (e) => {
        if (e.target === els.gcalSyncModalBackdrop) closeGcalSyncModal();
      });
    }
    if (els.downloadIcsBtn) els.downloadIcsBtn.addEventListener('click', () => downloadIcsCalendar());
    if (els.gcalDownloadIcsBtn) els.gcalDownloadIcsBtn.addEventListener('click', () => downloadIcsCalendar());
    if (els.gcalCopyFeedBtn) {
      els.gcalCopyFeedBtn.addEventListener('click', async () => {
        const feedUrl = (els.gcalFeedUrlInput && els.gcalFeedUrlInput.value) || `${window.location.origin}/api/calendar.ics`;
        try {
          await navigator.clipboard.writeText(feedUrl);
          showToast('Copied iCal feed link for Google Calendar.');
        } catch (_) {
          window.prompt('Copy this iCal URL:', feedUrl);
        }
      });
    }
    if (els.gcalWebSyncBtn) {
      els.gcalWebSyncBtn.addEventListener('click', () => {
        const feedUrl = (els.gcalFeedUrlInput && els.gcalFeedUrlInput.value) || `${window.location.origin}/api/calendar.ics`;
        const webcalUrl = feedUrl.replace(/^https?:\/\//i, 'webcal://');
        const gcalUrl = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`;
        window.open(gcalUrl, '_blank', 'noopener,noreferrer');
      });
    }

    // Direct Canvas Submission Event Listeners
    if (els.submitTabUrlBtn) els.submitTabUrlBtn.addEventListener('click', () => switchSubmissionTab('url'));
    if (els.submitTabFileBtn) els.submitTabFileBtn.addEventListener('click', () => switchSubmissionTab('file'));
    if (els.submitTabTextBtn) els.submitTabTextBtn.addEventListener('click', () => switchSubmissionTab('text'));
    if (els.closeSubmissionModalBtn) els.closeSubmissionModalBtn.addEventListener('click', closeSubmissionModal);
    if (els.submissionModalBackdrop) {
      els.submissionModalBackdrop.addEventListener('click', (e) => {
        if (e.target === els.submissionModalBackdrop) closeSubmissionModal();
      });
    }

    if (els.submissionUrlForm) {
      els.submissionUrlForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const urlVal = (els.submissionUrlInput.value || '').trim();
        submitAssignmentPayload(
          { submission_type: 'online_url', url: urlVal },
          els.submissionErrorNotice,
          els.submissionSubmitBtn,
          'Turn In to Canvas →'
        );
      });
    }

    if (els.submissionTextForm) {
      els.submissionTextForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const textVal = (els.submissionTextInput.value || '').trim();
        submitAssignmentPayload(
          { submission_type: 'online_text_entry', body: textVal },
          els.submissionTextErrorNotice,
          els.submissionTextSubmitBtn,
          'Turn In to Canvas →'
        );
      });
    }

    if (els.submissionFileForm) {
      els.submissionFileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = els.submissionFileInput && els.submissionFileInput.files && els.submissionFileInput.files[0];
        if (!file) {
          if (els.submissionFileErrorNotice) {
            els.submissionFileErrorNotice.textContent = 'Please select a file to upload.';
            els.submissionFileErrorNotice.classList.remove('hidden');
          }
          return;
        }

        if (state.cloudStaticMode) {
          if (els.submissionFileErrorNotice) {
            els.submissionFileErrorNotice.textContent = 'File uploads require local Node API backend. Click "Open in Canvas instead" below.';
            els.submissionFileErrorNotice.classList.remove('hidden');
          }
          return;
        }

        if (!state.activeSubmission) return;
        const { courseId, assignmentId } = state.activeSubmission;

        els.submissionFileErrorNotice.classList.add('hidden');
        els.submissionFileSubmitBtn.disabled = true;
        els.submissionFileSubmitBtn.textContent = 'Uploading to Canvas...';

        try {
          // 1. Handshake with Canvas via server
          const handshakeRes = await apiFetch(
            `/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self/files`,
            {
              method: 'POST',
              body: {
                name: file.name,
                size: file.size,
                content_type: file.type || 'application/octet-stream',
              },
            }
          );

          if (!handshakeRes.ok) {
            throw new Error(`Upload handshake failed (HTTP ${handshakeRes.status})`);
          }

          const handshakeData = await handshakeRes.json();
          const uploadUrl = handshakeData.upload_url;
          const uploadParams = handshakeData.upload_params || {};
          const safeUploadUrl = safeHttpUrl(uploadUrl);
          if (
            !safeUploadUrl ||
            !/^https:\/\//i.test(String(uploadUrl || '').trim()) ||
            !safeUploadUrl.startsWith('https://')
          ) {
            throw new Error('Canvas returned an invalid file-upload URL.');
          }

          // 2. Upload file directly to Canvas storage
          const formData = new FormData();
          Object.entries(uploadParams).forEach(([k, v]) => formData.append(k, v));
          formData.append('file', file);

          const uploadRes = await fetch(safeUploadUrl, {
            method: 'POST',
            body: formData,
          });

          if (!uploadRes.ok) {
            throw new Error('File transfer to Canvas storage failed.');
          }

          const uploadResult = await uploadRes.json();
          const fileId = uploadResult.id;

          // 3. Finalize assignment submission with file_id
          await submitAssignmentPayload(
            { submission_type: 'online_upload', file_ids: [fileId] },
            els.submissionFileErrorNotice,
            els.submissionFileSubmitBtn,
            'Upload & Turn In →'
          );
        } catch (err) {
          els.submissionFileErrorNotice.textContent = err.message || 'File upload failed. Open in Canvas instead.';
          els.submissionFileErrorNotice.classList.remove('hidden');
        } finally {
          els.submissionFileSubmitBtn.disabled = false;
          els.submissionFileSubmitBtn.textContent = 'Upload & Turn In →';
        }
      });
    }
  }

  
    // 24/7 Offline Continuity & Service Worker Registration
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((error) => {
          console.warn('Offline support could not be initialized:', error);
        });
      });
    }

    const updateOnlineIndicator = () => {
      if (els.offlineStatusBadge) {
        els.offlineStatusBadge.classList.toggle('hidden', navigator.onLine);
      }
    };
    window.addEventListener('online', () => {
      updateOnlineIndicator();
      if (state.authenticated) loadDashboardData(true);
    });
    window.addEventListener('offline', updateOnlineIndicator);
    updateOnlineIndicator();

    // Sound Celebration Chime Toggle
    const updateSoundToggleUI = () => {
      if (els.soundToggleIcon) {
        els.soundToggleIcon.textContent = state.soundMuted ? '🔇' : '🔊';
      }
      if (els.soundToggleBtn) {
        els.soundToggleBtn.title = state.soundMuted ? 'Audio chime muted (Click to unmute)' : 'Audio chime active (Click to mute)';
      }
    };
    updateSoundToggleUI();

    if (els.soundToggleBtn) {
      els.soundToggleBtn.addEventListener('click', () => {
        state.soundMuted = !state.soundMuted;
        setStoredItem('localStorage', 'slated_sound_muted', String(state.soundMuted));
        updateSoundToggleUI();
        showToast(state.soundMuted ? 'Audio muted for study hall / library.' : 'Audio chime enabled.');
      });
    }

    // Compact View Toggle
    if (els.compactViewToggleBtn) {
      els.compactViewToggleBtn.textContent = state.compactView ? 'Comfortable' : 'Compact';
      els.compactViewToggleBtn.addEventListener('click', () => {
        state.compactView = !state.compactView;
        setStoredItem('localStorage', 'slated_compact_view', String(state.compactView));
        els.compactViewToggleBtn.textContent = state.compactView ? 'Comfortable' : 'Compact';
        if (els.assignmentsList) {
          els.assignmentsList.classList.toggle('compact-queue', Boolean(state.compactView));
        }
        showToast(state.compactView ? 'Switched to Compact density view.' : 'Switched to Comfortable view.');
      });
    }

    // 1-Page Weekly Gameplan Print
    if (els.printGameplanBtn) {
      els.printGameplanBtn.addEventListener('click', () => {
        window.print();
      });
    }

    // Teacher Briefings Live Keyword Search
    if (els.annSearchInput) {
      els.annSearchInput.addEventListener('input', (e) => {
        state.announcementSearch = e.target.value.trim();
        renderAll();
      });
    }

    // Resources Vault Class Tab Switching
    document.querySelectorAll('.res-class-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        state.resourceClassFilter = tabBtn.getAttribute('data-res-class') || 'all';
        document.querySelectorAll('.res-class-tab').forEach((b) => {
          b.classList.toggle('studio-btn-primary', b === tabBtn);
          b.classList.toggle('tone-surface', b !== tabBtn);
        });
        renderResourcesVault();
      });
    });

    // Resources Vault Category Filtering
    if (els.resourceCategorySelect) {
      els.resourceCategorySelect.addEventListener('change', (e) => {
        state.resourceCategoryFilter = e.target.value;
        state.resourcePage = 1;
        state.resourcesPage = 1;
        renderResourcesVault();
      });
    }

    // Resources Vault Live Search
    if (els.resourceSearchInput) {
      els.resourceSearchInput.addEventListener('input', (e) => {
        state.resourceSearch = e.target.value.trim();
        state.resourcePage = 1;
        state.resourcesPage = 1;
        renderResourcesVault();
      });
    }

    // Sync Entire Pacing Month to Google Calendar
    if (els.syncPacingToGcalBtn) {
      els.syncPacingToGcalBtn.addEventListener('click', () => {
        const cal = state.pacingCalendar || CONDER_PACING_CALENDAR;
        const upcomingMilestones = (cal.milestones || []).filter(        (m) => m.date >= localDateKey());
        if (upcomingMilestones.length === 0) {
          showToast('No upcoming milestones left in this month.');
          return;
        }
        // Open the next milestone in Google Calendar
        const nextM = upcomingMilestones[0];
        const title = encodeURIComponent(`AP World: ${nextM.label}`);
        const datesParam = `&dates=${nextM.date.replace(/-/g, '')}T130000Z/${nextM.date.replace(/-/g, '')}T143000Z`;
        const details = encodeURIComponent(`${nextM.detail}\nReading: ${nextM.reading || 'None'}\n\nPacing Calendar: Conder AP World`);
        const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}${datesParam}&details=${details}&location=Enloe%20High%20School`;
        window.open(url, '_blank', 'noopener,noreferrer');
        showToast('Opened Google Calendar for next milestone. Download the .ics to import all at once!');
      });
    }

  
  window.slated = {
    state,
    renderAll,
    safeRender,
    openStudyLabDrawer,
    openBriefingsDrawer,
    openResourcesDrawer,
    openPacingDrawer,
    openCalendarDrawer,
    closeAllDrawers,
    downloadIcs: downloadIcsCalendar,
    copyIcalFeed: copyIcalFeedUrl,
  };

  bindEvents();
  checkSessionAndLoad();
})();
