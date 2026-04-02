import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { GoogleAuthService } from './google-auth.js';

const TIMEZONE = 'America/Sao_Paulo';
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 19;
const MIN_SLOT_MINUTES = 30;

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: { name: string; email: string }[];
  location: string | null;
  meetLink: string | null;
  description: string | null;
  isRecurring: boolean;
  calendarId: string;
}

const MEET_ZOOM_REGEX = /https:\/\/(meet\.google\.com\/[a-z\-]+|[\w.-]*zoom\.us\/j\/\d+[^\s]*)/gi;

function extractMeetLink(event: calendar_v3.Schema$Event): string | null {
  if (event.hangoutLink) return event.hangoutLink;

  const fields = [event.location, event.description].filter(Boolean).join(' ');
  const match = fields.match(MEET_ZOOM_REGEX);
  return match?.[0] ?? null;
}

function parseEvent(event: calendar_v3.Schema$Event, calendarId: string): CalendarEvent {
  return {
    id: event.id ?? '',
    title: event.summary ?? '(No title)',
    start: event.start?.dateTime ?? event.start?.date ?? '',
    end: event.end?.dateTime ?? event.end?.date ?? '',
    attendees: (event.attendees ?? []).map((a) => ({
      name: a.displayName ?? a.email ?? '',
      email: a.email ?? '',
    })),
    location: event.location ?? null,
    meetLink: extractMeetLink(event),
    description: event.description ?? null,
    isRecurring: !!event.recurringEventId,
    calendarId,
  };
}

function dayBoundaries(date: Date): { start: string; end: string } {
  const dateStr = date.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
  return {
    start: `${dateStr}T00:00:00`,
    end: `${dateStr}T23:59:59`,
  };
}

function toZonedISO(dateStr: string): string {
  // Construct an ISO string that the Google API can interpret in our timezone
  const d = new Date(dateStr);
  return d.toISOString();
}

export class CalendarService {
  constructor(private auth: GoogleAuthService) {}

  private getCalendar(): calendar_v3.Calendar {
    return google.calendar({ version: 'v3', auth: this.auth.getClient() });
  }

  private async listCalendarIds(): Promise<string[]> {
    try {
      const calendar = this.getCalendar();
      const res = await calendar.calendarList.list();
      return (res.data.items ?? [])
        .filter((c) => !c.deleted && c.accessRole !== 'freeBusyReader')
        .map((c) => c.id!)
        .filter(Boolean);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Calendar] Failed to list calendars:', message);
      throw new Error(`Failed to list calendars: ${message}`);
    }
  }

  async getEventsForDateRange(start: string, end: string): Promise<CalendarEvent[]> {
    try {
      const calendar = this.getCalendar();
      const calendarIds = await this.listCalendarIds();

      const allEvents: CalendarEvent[] = [];

      for (const calId of calendarIds) {
        const res = await calendar.events.list({
          calendarId: calId,
          timeMin: new Date(start).toISOString(),
          timeMax: new Date(end).toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: TIMEZONE,
        });

        const events = (res.data.items ?? []).map((e) => parseEvent(e, calId));
        allEvents.push(...events);
      }

      allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      return allEvents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Calendar] Failed to get events for date range:', message);
      throw new Error(`Failed to get events: ${message}`);
    }
  }

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const { start, end } = dayBoundaries(now);
    return this.getEventsForDateRange(start, end);
  }

  async getWeekEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const { start } = dayBoundaries(now);

    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
    const { end } = dayBoundaries(weekEnd);

    return this.getEventsForDateRange(start, end);
  }

  async getEventDetails(eventId: string): Promise<CalendarEvent> {
    try {
      const calendar = this.getCalendar();
      const calendarIds = await this.listCalendarIds();

      for (const calId of calendarIds) {
        try {
          const res = await calendar.events.get({
            calendarId: calId,
            eventId,
            timeZone: TIMEZONE,
          });
          return parseEvent(res.data, calId);
        } catch {
          // Event not in this calendar, try the next one
        }
      }

      throw new Error(`Event ${eventId} not found in any calendar`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Calendar] Failed to get event details:', message);
      throw new Error(`Failed to get event details: ${message}`);
    }
  }

  async findFreeSlots(date?: string): Promise<{ start: string; end: string }[]> {
    try {
      const calendar = this.getCalendar();
      const targetDate = date ? new Date(date) : new Date();
      const dateStr = targetDate.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });

      const workStart = new Date(`${dateStr}T${String(WORK_START_HOUR).padStart(2, '0')}:00:00`);
      const workEnd = new Date(`${dateStr}T${String(WORK_END_HOUR).padStart(2, '0')}:00:00`);

      const calendarIds = await this.listCalendarIds();

      const res = await calendar.freebusy.query({
        requestBody: {
          timeMin: workStart.toISOString(),
          timeMax: workEnd.toISOString(),
          timeZone: TIMEZONE,
          items: calendarIds.map((id) => ({ id })),
        },
      });

      // Merge all busy intervals across calendars
      const busyIntervals: { start: number; end: number }[] = [];
      const calendars = res.data.calendars ?? {};
      for (const calId of Object.keys(calendars)) {
        const busy = calendars[calId]?.busy ?? [];
        for (const b of busy) {
          if (b.start && b.end) {
            busyIntervals.push({
              start: new Date(b.start).getTime(),
              end: new Date(b.end).getTime(),
            });
          }
        }
      }

      // Sort and merge overlapping busy intervals
      busyIntervals.sort((a, b) => a.start - b.start);
      const merged: { start: number; end: number }[] = [];
      for (const interval of busyIntervals) {
        const last = merged[merged.length - 1];
        if (last && interval.start <= last.end) {
          last.end = Math.max(last.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }

      // Find free slots between busy intervals
      const freeSlots: { start: string; end: string }[] = [];
      let cursor = workStart.getTime();
      const minSlotMs = MIN_SLOT_MINUTES * 60 * 1000;

      for (const busy of merged) {
        if (busy.start - cursor >= minSlotMs) {
          freeSlots.push({
            start: new Date(cursor).toISOString(),
            end: new Date(busy.start).toISOString(),
          });
        }
        cursor = Math.max(cursor, busy.end);
      }

      // Remaining time after last busy slot
      if (workEnd.getTime() - cursor >= minSlotMs) {
        freeSlots.push({
          start: new Date(cursor).toISOString(),
          end: workEnd.toISOString(),
        });
      }

      return freeSlots;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Calendar] Failed to find free slots:', message);
      throw new Error(`Failed to find free slots: ${message}`);
    }
  }
}
