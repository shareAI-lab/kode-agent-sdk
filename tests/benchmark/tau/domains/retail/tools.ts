// ---------------------------------------------------------------------------
// Retail domain tool definitions (Anthropic API format)
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export function getRetailToolDefs(): ToolDef[] {
  return [
    {
      name: 'get_customer_details',
      description:
        'Look up customer information by customer ID. Returns name, email, phone, and membership tier.',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: {
            type: 'string',
            description: 'The customer ID (e.g. "CUST001")',
          },
        },
        required: ['customer_id'],
      },
    },
    {
      name: 'get_order_details',
      description:
        'Look up an order by order ID. Returns items, total, status, and dates.',
      input_schema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The order ID (e.g. "ORD001")',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'list_customer_orders',
      description:
        'List all orders for a given customer.',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: {
            type: 'string',
            description: 'The customer ID whose orders to list',
          },
        },
        required: ['customer_id'],
      },
    },
    {
      name: 'get_product_details',
      description:
        'Get details for a specific product including price, category, and stock.',
      input_schema: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'The product ID (e.g. "PROD001")',
          },
        },
        required: ['product_id'],
      },
    },
    {
      name: 'search_products',
      description:
        'Search for products by name or category. Returns matching products with availability.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term to match against product name or category',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'process_return',
      description:
        'Process a return for an order. Sets the order status to "returned" and restocks items. Only valid for delivered orders within the return window.',
      input_schema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The order ID to return',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'process_exchange',
      description:
        'Exchange an item in an order for a different product. The original item is restocked and the new item is deducted from stock.',
      input_schema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The order ID containing the item to exchange',
          },
          old_product_id: {
            type: 'string',
            description: 'The product ID being returned',
          },
          new_product_id: {
            type: 'string',
            description: 'The product ID to exchange for',
          },
        },
        required: ['order_id', 'old_product_id', 'new_product_id'],
      },
    },
    {
      name: 'update_order_status',
      description:
        'Update the status of an order (e.g. to "cancelled").',
      input_schema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The order ID to update',
          },
          new_status: {
            type: 'string',
            enum: ['pending', 'shipped', 'delivered', 'cancelled', 'returned'],
            description: 'The new status',
          },
        },
        required: ['order_id', 'new_status'],
      },
    },
  ];
}
