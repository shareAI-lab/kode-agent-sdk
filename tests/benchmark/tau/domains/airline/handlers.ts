// ---------------------------------------------------------------------------
// Airline domain tool handlers
// ---------------------------------------------------------------------------

export type ToolHandler = (db: any, args: any) => any;

export function getAirlineHandlers(): Record<string, ToolHandler> {
  return {
    get_user_details: (db, args: { user_id: string }) => {
      const user = db.users.find((u: any) => u.user_id === args.user_id);
      if (!user) return { error: `User not found: ${args.user_id}` };
      return user;
    },

    get_reservation_details: (db, args: { reservation_id: string }) => {
      const res = db.reservations.find((r: any) => r.reservation_id === args.reservation_id);
      if (!res) return { error: `Reservation not found: ${args.reservation_id}` };
      return res;
    },

    list_user_reservations: (db, args: { user_id: string }) => {
      const list = db.reservations.filter((r: any) => r.user_id === args.user_id);
      return { reservations: list };
    },

    get_flight_details: (db, args: { flight_id: string }) => {
      const flight = db.flights.find((f: any) => f.flight_id === args.flight_id);
      if (!flight) return { error: `Flight not found: ${args.flight_id}` };
      return flight;
    },

    search_flights: (db, args: { route: string; date?: string }) => {
      let results = db.flights.filter((f: any) => f.route === args.route);
      if (args.date) {
        results = results.filter((f: any) => f.date === args.date);
      }
      return { flights: results };
    },

    update_reservation: (db, args: { reservation_id: string; new_flight_id: string }) => {
      const res = db.reservations.find((r: any) => r.reservation_id === args.reservation_id);
      if (!res) return { error: `Reservation not found: ${args.reservation_id}` };
      if (res.status === 'cancelled') return { error: 'Cannot update a cancelled reservation' };

      const newFlight = db.flights.find((f: any) => f.flight_id === args.new_flight_id);
      if (!newFlight) return { error: `Flight not found: ${args.new_flight_id}` };
      if (newFlight.seats_available <= 0) return { error: `No seats available on flight ${args.new_flight_id}` };

      // Release seat on old flight
      const oldFlight = db.flights.find((f: any) => f.flight_id === res.flight_id);
      if (oldFlight) oldFlight.seats_available += 1;

      // Book seat on new flight
      newFlight.seats_available -= 1;
      res.flight_id = args.new_flight_id;
      res.payment_amount = newFlight.price;

      return { success: true, reservation: { ...res } };
    },

    cancel_reservation: (db, args: { reservation_id: string }) => {
      const res = db.reservations.find((r: any) => r.reservation_id === args.reservation_id);
      if (!res) return { error: `Reservation not found: ${args.reservation_id}` };
      if (res.status === 'cancelled') return { error: 'Reservation is already cancelled' };

      // Release seat
      const flight = db.flights.find((f: any) => f.flight_id === res.flight_id);
      if (flight) flight.seats_available += 1;

      res.status = 'cancelled';
      return { success: true, reservation: { ...res } };
    },
  };
}
