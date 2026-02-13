// ---------------------------------------------------------------------------
// Airline domain database types and initial data
// ---------------------------------------------------------------------------

export interface User {
  user_id: string;
  name: string;
  email: string;
  phone: string;
  membership: 'regular' | 'silver' | 'gold' | 'platinum';
}

export interface Flight {
  flight_id: string;
  airline: string;
  route: string;
  date: string;
  departure_time: string;
  arrival_time: string;
  price: number;
  seats_available: number;
  aircraft: string;
}

export interface Reservation {
  reservation_id: string;
  user_id: string;
  flight_id: string;
  status: 'confirmed' | 'cancelled' | 'pending';
  seat_class: 'economy' | 'business' | 'first';
  payment_amount: number;
  booked_at: string;
}

export interface AirlineDatabase {
  users: User[];
  flights: Flight[];
  reservations: Reservation[];
}

export function getInitialDatabase(): AirlineDatabase {
  return {
    users: [
      {
        user_id: 'USR001',
        name: 'John Smith',
        email: 'john.smith@email.com',
        phone: '555-0101',
        membership: 'gold',
      },
      {
        user_id: 'USR002',
        name: 'Alice Johnson',
        email: 'alice.j@email.com',
        phone: '555-0102',
        membership: 'regular',
      },
      {
        user_id: 'USR003',
        name: 'Bob Chen',
        email: 'bob.chen@email.com',
        phone: '555-0103',
        membership: 'silver',
      },
      {
        user_id: 'USR004',
        name: 'Maria Garcia',
        email: 'maria.g@email.com',
        phone: '555-0104',
        membership: 'platinum',
      },
      {
        user_id: 'USR005',
        name: 'David Kim',
        email: 'david.k@email.com',
        phone: '555-0105',
        membership: 'regular',
      },
    ],

    flights: [
      {
        flight_id: 'FL001',
        airline: 'SkyAir',
        route: 'SFO-LAX',
        date: '2026-03-15',
        departure_time: '08:00',
        arrival_time: '09:30',
        price: 150,
        seats_available: 42,
        aircraft: 'A320',
      },
      {
        flight_id: 'FL002',
        airline: 'SkyAir',
        route: 'SFO-LAX',
        date: '2026-03-15',
        departure_time: '14:00',
        arrival_time: '15:30',
        price: 180,
        seats_available: 15,
        aircraft: 'A320',
      },
      {
        flight_id: 'FL003',
        airline: 'SkyAir',
        route: 'SFO-LAX',
        date: '2026-03-17',
        departure_time: '08:00',
        arrival_time: '09:30',
        price: 160,
        seats_available: 38,
        aircraft: 'A320',
      },
      {
        flight_id: 'FL004',
        airline: 'SkyAir',
        route: 'SFO-LAX',
        date: '2026-03-17',
        departure_time: '18:00',
        arrival_time: '19:30',
        price: 200,
        seats_available: 5,
        aircraft: 'B737',
      },
      {
        flight_id: 'FL005',
        airline: 'SkyAir',
        route: 'LAX-JFK',
        date: '2026-03-20',
        departure_time: '10:00',
        arrival_time: '18:30',
        price: 350,
        seats_available: 60,
        aircraft: 'B777',
      },
      {
        flight_id: 'FL006',
        airline: 'SkyAir',
        route: 'JFK-SFO',
        date: '2026-03-22',
        departure_time: '07:00',
        arrival_time: '10:30',
        price: 380,
        seats_available: 22,
        aircraft: 'A350',
      },
      {
        flight_id: 'FL007',
        airline: 'SkyAir',
        route: 'SFO-SEA',
        date: '2026-03-18',
        departure_time: '12:00',
        arrival_time: '14:00',
        price: 120,
        seats_available: 0,
        aircraft: 'A320',
      },
      {
        flight_id: 'FL008',
        airline: 'SkyAir',
        route: 'SFO-SEA',
        date: '2026-03-19',
        departure_time: '12:00',
        arrival_time: '14:00',
        price: 130,
        seats_available: 25,
        aircraft: 'A320',
      },
    ],

    reservations: [
      {
        reservation_id: 'RES001',
        user_id: 'USR001',
        flight_id: 'FL001',
        status: 'confirmed',
        seat_class: 'economy',
        payment_amount: 150,
        booked_at: '2026-02-01',
      },
      {
        reservation_id: 'RES002',
        user_id: 'USR002',
        flight_id: 'FL005',
        status: 'confirmed',
        seat_class: 'economy',
        payment_amount: 350,
        booked_at: '2026-02-05',
      },
      {
        reservation_id: 'RES003',
        user_id: 'USR003',
        flight_id: 'FL002',
        status: 'confirmed',
        seat_class: 'business',
        payment_amount: 360,
        booked_at: '2026-02-10',
      },
      {
        reservation_id: 'RES004',
        user_id: 'USR004',
        flight_id: 'FL006',
        status: 'confirmed',
        seat_class: 'first',
        payment_amount: 760,
        booked_at: '2026-01-20',
      },
      {
        reservation_id: 'RES005',
        user_id: 'USR005',
        flight_id: 'FL007',
        status: 'confirmed',
        seat_class: 'economy',
        payment_amount: 120,
        booked_at: '2026-02-15',
      },
    ],
  };
}
