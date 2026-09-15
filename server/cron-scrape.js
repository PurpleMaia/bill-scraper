/* Exclusive file function for cron job to call (same logic as main() in scrapingService.js) */
import { startScraping } from './services/scrapingService.js';
import { sendAlertEmail } from './services/notifications/cron-alerts.js';
import { sendDailyDigest } from './services/notificationService.js';
import { checkApproachingDeadlines, checkTestimonyDeadlines } from './services/notifications/deadline-warnings.js';
import { fetchLivingNonSim, fetchLivingNonSimWithStatus } from './services/sim/simDeadlineFetchers.js';

async function cronScrape() {
    const currentYear = new Date().getFullYear();
    console.log(`Starting cron job, scraping for year ${currentYear}...`);

    const houseURL = `https://data.capitol.hawaii.gov/advreports/advreport.aspx?year=${currentYear}&report=deadline&active=true&rpt_type=&measuretype=hb&title=House%20Bills%20with%20Action%20Taken%20in%20${currentYear}%20Only`;
    const senateURL = `https://data.capitol.hawaii.gov/advreports/advreport.aspx?year=${currentYear}&report=deadline&active=true&rpt_type=&measuretype=sb&title=Senate%20Bills%20with%20Action%20Taken%20in%20${currentYear}%20Only`;

    const errors = [];

    // Scrape House bills URL
    console.log('[MAIN] Scraping House bills...');
    const houseResult = await startScraping(houseURL);
    console.log(`[MAIN] Finished scraping House bills in ${houseResult.durationMin} minutes.`);

    if (!houseResult.totalBills) {
      errors.push(`House bills: 0 bills scraped from ${houseURL}`);
    }

    // Scrape Senate bills URL
    console.log('[MAIN] Scraping Senate bills...');
    const senateResult = await startScraping(senateURL);
    console.log(`[MAIN] Finished scraping Senate bills in ${senateResult.durationMin} minutes.`);

    if (!senateResult.totalBills) {
      errors.push(`Senate bills: 0 bills scraped from ${senateURL}`);
    }

    // Collect all individual failures across both chambers
    const allIndividualFailures = [];
    for (const [label, result] of [['House', houseResult], ['Senate', senateResult]]) {
      if (result?.individualFailCount > 0) {
        errors.push(`${label}: ${result.individualFailCount}/${result.totalIndividual} individual bill scrapes failed`);
        for (const f of (result.individualFailures || [])) {
          allIndividualFailures.push({ ...f, chamber: label });
        }
      }
    }

    // Send cron job alert email if there were any errors or individual failures
    if (errors.length > 0) {
      const body = [
        `Cron job completed at ${new Date().toISOString()} with issues:`,
        '',
        ...errors.map(e => `- ${e}`),
        '',
        `Year: ${currentYear}`,
        `House bills scraped: ${houseResult.totalBills ?? 0}`,
        `Senate bills scraped: ${senateResult.totalBills ?? 0}`,
      ];

      if (allIndividualFailures.length > 0) {
        body.push('', '--- Individual Bill Failures ---', '');
        for (const f of allIndividualFailures) {
          body.push(`  [${f.chamber}] Bill ID ${f.billId}: ${f.reason}`);
        }
      }

      await sendAlertEmail('Scraping completed with failures', body.join('\n'));
    }

    // Notify followers of any bill status / dead changes detected this run.
    // Merge changes collected across both chambers. Wrapped so a notification
    // failure never fails the scrape.
    //
    // Sim Week: the sim board advance is intentionally NOT run here.
    // It is owned solely by scripts/sim/run-day.js (the 5PM HST cron). Advancing
    // it here too double-advanced the board and let this scrape consume the sim
    // status diff, so run-day.js's own sim-scoped follower emails found nothing
    // to send. The real deadline scan below already excludes sim bills via
    // fetchLivingNonSim*, so this scrape stays fully sim-free.
    // See docs/…/sim-week-design.md and server/tests/cronScrapeNoSim.test.js.

    // ONE combined daily digest per user: bills that changed status this run OR
    // are approaching a deadline. The deadline SCAN still runs here to find
    // at-risk bills; the two used to be separate emails and are now merged into
    // a single message. Wrapped so a failure never fails the scrape.
    try {
      const today = new Date().toISOString().split('T')[0];
      const allChanges = [
        ...(houseResult?.statusChanges || []),
        ...(senateResult?.statusChanges || []),
      ];
      // Approaching legislative deadlines (7-day / 3-day) + testimony windows
      // closing. Sim bills are excluded from the real deadline scan: the real
      // session deadlines all predate the sim window, so they'd read as
      // "missed deadline". (See docs/…/sim-week-design.md §5a.)
      const [deadlineWarnings, testimonyWarnings] = await Promise.all([
        checkApproachingDeadlines(today, { fetchBills: fetchLivingNonSim }),
        checkTestimonyDeadlines(today, { fetchBills: fetchLivingNonSimWithStatus }),
      ]);
      const warnings = [...deadlineWarnings, ...testimonyWarnings];

      const { usersNotified, billsIncluded } = await sendDailyDigest(allChanges, warnings, { today });
      console.log(`[MAIN] Daily digest: ${usersNotified} user(s), ${billsIncluded} bill(s) (${allChanges.length} change(s), ${warnings.length} at-risk, ${testimonyWarnings.length} testimony-closing)`);
    } catch (notifyErr) {
      console.error('[MAIN] Daily digest dispatch failed:', notifyErr);
      await sendAlertEmail('Daily digest dispatch failed', [
        `The daily digest notification step failed at ${new Date().toISOString()}.`,
        '',
        `Error: ${notifyErr?.message || notifyErr}`,
        '',
        notifyErr?.stack || 'No stack trace available',
      ].join('\n'));
    }
}

cronScrape().catch(async (error) => {
  console.error('Error during cron job scraping:', error);

  await sendAlertEmail('Cron job CRASHED', [
    `The daily scrape cron job crashed at ${new Date().toISOString()}.`,
    '',
    `Error: ${error?.message || error}`,
    '',
    `Stack trace:`,
    error?.stack || 'No stack trace available',
  ].join('\n'));

  process.exit(1);
});

