const mysql = require('mysql2/promise');
const { google } = require('googleapis');
const calendar = google.calendar('v3');

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_SECRET;
const oauthRedirectUri = process.env.OAUTH_REDIRECT_URI;

const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const removeTimeZoneOffset = (timeWithOffset) => {
  return timeWithOffset.replace(/\+[\d:]+$/, '');
};

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const connection = await pool.getConnection(async (conn) => conn);

    await connection.query(`TRUNCATE TABLE events;`);

    const users = (
      await connection.query(
        `SELECT slack_user_id slackUserId FROM webhooks WHERE webhook_id IS NOT NULL;`
      )
    )[0];

    for (const user of users) {
      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        oauthRedirectUri
      );

      const slackUserId = user.slackUserId;
      const refreshToken = (
        await connection.query(
          `SELECT refresh_token refreshToken FROM users WHERE slack_user_id = ?`,
          [slackUserId]
        )
      )[0][0];

      oauth2Client.setCredentials({
        refresh_token: refreshToken.refreshToken,
      });

      const userInfo = (
        await connection.query(
          `SELECT w.slack_channel slackChannel, w.calendar calendar, u.slack_team_id slackTeamId FROM webhooks w JOIN users u ON w.slack_user_id = u.slack_user_id WHERE w.slack_user_id = ?;`,
          [slackUserId]
        )
      )[0][0];

      const startOfDay = new Date();
      startOfDay.setHours(9, 0, 0, 0);

      const endOfDay = new Date();
      endOfDay.setHours(32, 59, 59, 999);

      const eventList = await calendar.events.list({
        auth: oauth2Client,
        calendarId: userInfo.calendar,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: 'Asia/Seoul',
      });

      const events = eventList.data.items;

      for (const event of events) {
        const eventStartTime = event.start.dateTime
          ? removeTimeZoneOffset(event.start.dateTime)
          : event.start.date;
        const eventEndTime = event.end.dateTime
          ? removeTimeZoneOffset(event.end.dateTime)
          : event.end.date;

        await connection.query(
          `INSERT INTO events (summary, link, start_time, end_time, slack_user_id) VALUES (?, ?, ?, ?, ?)`,
          [
            event.summary,
            event.htmlLink || '',
            eventStartTime,
            eventEndTime,
            slackUserId,
          ]
        );
      }
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.stack }),
    };
  }
};
