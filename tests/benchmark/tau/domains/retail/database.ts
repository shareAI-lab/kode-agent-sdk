// ---------------------------------------------------------------------------
// Retail domain database types and initial data
// ---------------------------------------------------------------------------

export interface Customer {
  customer_id: string;
  name: string;
  email: string;
  phone: string;
  membership: 'regular' | 'vip' | 'premium';
}

export interface Product {
  product_id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
}

export interface OrderItem {
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
}

export interface Order {
  order_id: string;
  customer_id: string;
  items: OrderItem[];
  total: number;
  status: 'pending' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
  order_date: string;
  delivery_date?: string;
}

export interface RetailDatabase {
  customers: Customer[];
  products: Product[];
  orders: Order[];
}

export function getInitialDatabase(): RetailDatabase {
  return {
    customers: [
      {
        customer_id: 'CUST001',
        name: 'Emma Wilson',
        email: 'emma.w@email.com',
        phone: '555-1001',
        membership: 'vip',
      },
      {
        customer_id: 'CUST002',
        name: 'James Brown',
        email: 'james.b@email.com',
        phone: '555-1002',
        membership: 'regular',
      },
      {
        customer_id: 'CUST003',
        name: 'Sophia Lee',
        email: 'sophia.l@email.com',
        phone: '555-1003',
        membership: 'premium',
      },
      {
        customer_id: 'CUST004',
        name: 'Liam Martinez',
        email: 'liam.m@email.com',
        phone: '555-1004',
        membership: 'regular',
      },
      {
        customer_id: 'CUST005',
        name: 'Olivia Davis',
        email: 'olivia.d@email.com',
        phone: '555-1005',
        membership: 'vip',
      },
    ],

    products: [
      { product_id: 'PROD001', name: 'Wireless Headphones', category: 'Electronics', price: 79.99, stock: 150 },
      { product_id: 'PROD002', name: 'Bluetooth Speaker', category: 'Electronics', price: 49.99, stock: 80 },
      { product_id: 'PROD003', name: 'Running Shoes (Size 10)', category: 'Footwear', price: 129.99, stock: 30 },
      { product_id: 'PROD004', name: 'Running Shoes (Size 11)', category: 'Footwear', price: 129.99, stock: 0 },
      { product_id: 'PROD005', name: 'Cotton T-Shirt (M)', category: 'Apparel', price: 24.99, stock: 200 },
      { product_id: 'PROD006', name: 'Cotton T-Shirt (L)', category: 'Apparel', price: 24.99, stock: 180 },
      { product_id: 'PROD007', name: 'Yoga Mat', category: 'Fitness', price: 34.99, stock: 60 },
      { product_id: 'PROD008', name: 'Water Bottle (32oz)', category: 'Fitness', price: 19.99, stock: 100 },
      { product_id: 'PROD009', name: 'Laptop Stand', category: 'Electronics', price: 59.99, stock: 45 },
      { product_id: 'PROD010', name: 'USB-C Hub', category: 'Electronics', price: 39.99, stock: 70 },
    ],

    orders: [
      {
        order_id: 'ORD001',
        customer_id: 'CUST001',
        items: [
          { product_id: 'PROD001', product_name: 'Wireless Headphones', quantity: 1, unit_price: 79.99 },
          { product_id: 'PROD008', product_name: 'Water Bottle (32oz)', quantity: 2, unit_price: 19.99 },
        ],
        total: 119.97,
        status: 'delivered',
        order_date: '2026-01-15',
        delivery_date: '2026-01-22',
      },
      {
        order_id: 'ORD002',
        customer_id: 'CUST002',
        items: [
          { product_id: 'PROD003', product_name: 'Running Shoes (Size 10)', quantity: 1, unit_price: 129.99 },
        ],
        total: 129.99,
        status: 'delivered',
        order_date: '2026-01-20',
        delivery_date: '2026-01-27',
      },
      {
        order_id: 'ORD003',
        customer_id: 'CUST003',
        items: [
          { product_id: 'PROD005', product_name: 'Cotton T-Shirt (M)', quantity: 3, unit_price: 24.99 },
        ],
        total: 74.97,
        status: 'delivered',
        order_date: '2025-12-10',
        delivery_date: '2025-12-17',
      },
      {
        order_id: 'ORD004',
        customer_id: 'CUST004',
        items: [
          { product_id: 'PROD009', product_name: 'Laptop Stand', quantity: 1, unit_price: 59.99 },
          { product_id: 'PROD010', product_name: 'USB-C Hub', quantity: 1, unit_price: 39.99 },
        ],
        total: 99.98,
        status: 'shipped',
        order_date: '2026-02-05',
      },
      {
        order_id: 'ORD005',
        customer_id: 'CUST005',
        items: [
          { product_id: 'PROD007', product_name: 'Yoga Mat', quantity: 1, unit_price: 34.99 },
        ],
        total: 34.99,
        status: 'delivered',
        order_date: '2026-02-01',
        delivery_date: '2026-02-07',
      },
    ],
  };
}
