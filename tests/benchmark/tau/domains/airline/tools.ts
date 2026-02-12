// ---------------------------------------------------------------------------
// Airline domain tool definitions (Anthropic API format)
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export function getAirlineToolDefs(): ToolDef[] {
  return [
    {
      name: 'get_user_details',
      description:
        'Look up a user by their user ID. Returns user profile including name, email, phone, and membership tier.',
      input_schema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The user ID to look up (e.g. "USR001")',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'get_reservation_details',
      description:
        'Look up a reservation by reservation ID. Returns booking details including flight, status, and payment.',
      input_schema: {
        type: 'object',
        properties: {
          reservation_id: {
            type: 'string',
            description: 'The reservation ID (e.g. "RES001")',
          },
        },
        required: ['reservation_id'],
      },
    },
    {
      name: 'list_user_reservations',
      description:
        'List all reservations for a given user. Returns an array of reservation records.',
      input_schema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The user ID whose reservations to list',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'get_flight_details',
      description:
        'Get details for a specific flight by flight ID. Returns route, schedule, price, and availability.',
      input_schema: {
        type: 'object',
        properties: {
          flight_id: {
            type: 'string',
            description: 'The flight ID (e.g. "FL001")',
          },
        },
        required: ['flight_id'],
      },
    },
    {
      name: 'search_flights',
      description:
        'Search for available flights by route and optional date. Returns matching flights with availability.',
      input_schema: {
        type: 'object',
        properties: {
          route: {
            type: 'string',
            description: 'Flight route in "ORIGIN-DEST" format (e.g. "SFO-LAX")',
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format. If omitted, returns all dates.',
          },
        },
        required: ['route'],
      },
    },
    {
      name: 'update_reservation',
      description:
        'Update a reservation to change the flight. The new flight must have available seats.',
      input_schema: {
        type: 'object',
        properties: {
          reservation_id: {
            type: 'string',
            description: 'The reservation ID to update',
          },
          new_flight_id: {
            type: 'string',
            description: 'The new flight ID to switch to',
          },
        },
        required: ['reservation_id', 'new_flight_id'],
      },
    },
    {
      name: 'cancel_reservation',
      description:
        'Cancel a reservation. Sets the reservation status to "cancelled". Cannot be undone.',
      input_schema: {
        type: 'object',
        properties: {
          reservation_id: {
            type: 'string',
            description: 'The reservation ID to cancel',
          },
        },
        required: ['reservation_id'],
      },
    },
  ];
}
