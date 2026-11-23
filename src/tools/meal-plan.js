import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  server.registerTool("meal_plan", {
    title: "Meal Plan",
    description: `Manage AnyList meal planning calendar. Actions:
- list_events: Show meal plan events (sorted by date), then the meal plan Queue (recipes saved for later, with no date) in its own section
- list_labels: Show available labels (Breakfast, Lunch, Dinner, etc.) with IDs
- create_event: Add a meal plan event for a date (optionally marked as leftovers)
- delete_event: Delete a meal plan event by ID`,
    inputSchema: {
      action: z.enum(["list_events", "list_labels", "create_event", "delete_event"]).describe("The meal plan action to perform"),
      date: z.string().optional().describe("Date in YYYY-MM-DD format (required for create_event)"),
      start_date: z.string().optional().describe("Filter events on or after this date, YYYY-MM-DD (list_events only)"),
      end_date: z.string().optional().describe("Filter events on or before this date, YYYY-MM-DD (list_events only)"),
      title: z.string().optional().describe("Event title (create_event; use this OR recipe_id)"),
      recipe_id: z.string().optional().describe("Recipe ID to link (create_event)"),
      label_id: z.string().optional().describe("Label ID for meal type (create_event)"),
      details: z.string().optional().describe("Additional notes (create_event)"),
      is_leftover: z.boolean().optional().describe("Mark the event as leftovers (create_event)"),
      format: z.enum(["text", "json"]).optional().describe("Output format. For list_events, 'json' returns an array of {id, date, queued, title, details, recipeId, recipeName, label, labelId, isLeftover} for programmatic use (queued events have date null and come last); for create_event, 'json' returns {id, date, alreadyExists} (default text)"),
      event_id: z.string().optional().describe("Event ID to delete (required for delete_event)"),
    }
  }, async (params) => {
    const { action, date, start_date, end_date, title, recipe_id, label_id, details, event_id, is_leftover, format } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list_events": {
          const all = await client.getMealPlanEvents();
          // Queued events (the app's Queue tab) have no date: never on a day, so the date filters
          // don't apply to them. They are listed after the calendar, separately.
          const queue = all.filter(e => e.queued || !e.date);
          let events = all.filter(e => !(e.queued || !e.date));
          if (start_date) events = events.filter(e => e.date >= start_date);
          if (end_date) events = events.filter(e => e.date <= end_date);
          events.sort((a, b) => a.date.localeCompare(b.date));
          if (format === "json") {
            return textResponse(JSON.stringify([...events, ...queue].map(e => ({
              id: e.identifier, date: e.date || null, queued: !e.date, title: e.title || null, details: e.details || null,
              recipeId: e.recipeId || null, recipeName: e.recipeName || null,
              label: e.labelName || null, labelId: e.labelId || null, isLeftover: !!e.isLeftover,
            }))));
          }
          if (events.length === 0 && queue.length === 0) return textResponse("No meal plan events found.");
          const line = (e, head) => {
            const parts = [head];
            if (e.title) parts.push(e.title);
            if (e.recipeName) parts.push(`📖 ${e.recipeName}`);
            if (e.labelName) parts.push(`[${e.labelName}]`);
            if (e.details) parts.push(`— ${e.details}`);
            parts.push(`(id: ${e.identifier})`);
            return parts.join(' ');
          };
          const sections = [];
          if (events.length) sections.push(`Meal Plan (${events.length} events):\n${events.map(e => line(e, `- **${e.date}**`)).join('\n')}`);
          else sections.push("No meal plan events found.");
          if (queue.length) sections.push(`Queue — saved for later, not on any day (${queue.length}):\n${queue.map(e => line(e, "- **Queue**")).join('\n')}`);
          return textResponse(sections.join('\n\n'));
        }
        case "list_labels": {
          const labels = await client.getMealPlanLabels();
          if (labels.length === 0) return textResponse("No meal plan labels found.");
          const list = labels.map(l => `- **${l.name}** (${l.hexColor || 'no color'}) — id: ${l.identifier}`).join('\n');
          return textResponse(`Meal Plan Labels:\n${list}`);
        }
        case "create_event": {
          let eventDate = date;
          if (!eventDate) eventDate = await elicitRequiredField("date", "What date for the meal plan event? (YYYY-MM-DD)");
          // Retry safety (2026-10-03): the same title or recipe on the same date is
          // the earlier call having landed (e.g. a timed-out retry), not a second meal.
          const sameDay = (await client.getMealPlanEvents()).filter(e => e.date === eventDate);
          const duplicate = sameDay.find(e =>
            (title && e.title && e.title.toLowerCase() === title.toLowerCase()) ||
            (recipe_id && e.recipeId === recipe_id));
          if (duplicate) {
            if (format === "json") return textResponse(JSON.stringify({ id: duplicate.identifier, date: eventDate, alreadyExists: true }));
            return textResponse(`already_exists: meal plan already has ${duplicate.title || duplicate.recipeName || "that meal"} on ${eventDate} (id: ${duplicate.identifier}); nothing added`);
          }
          const result = await client.createMealPlanEvent({
            date: eventDate,
            title: title || null,
            recipeId: recipe_id || null,
            labelId: label_id || null,
            details: details || null,
            isLeftover: !!is_leftover,
          });
          if (format === "json") return textResponse(JSON.stringify({ id: result.identifier, date: result.date, alreadyExists: false }));
          return textResponse(`Created meal plan event for ${result.date} (id: ${result.identifier})`);
        }
        case "delete_event": {
          let eventId = event_id;
          if (!eventId) eventId = await elicitRequiredField("event_id", "Which event ID should be deleted?");
          await client.deleteMealPlanEvent(eventId);
          return textResponse(`Deleted meal plan event ${eventId}`);
        }
      }
    } catch (error) {
      return errorResponse(`Meal plan ${action} failed: ${error.message}`);
    }
  });
}
