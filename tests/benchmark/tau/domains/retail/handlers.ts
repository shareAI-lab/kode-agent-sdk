// ---------------------------------------------------------------------------
// Retail domain tool handlers
// ---------------------------------------------------------------------------

export type ToolHandler = (db: any, args: any) => any;

export function getRetailHandlers(): Record<string, ToolHandler> {
  return {
    get_customer_details: (db, args: { customer_id: string }) => {
      const customer = db.customers.find((c: any) => c.customer_id === args.customer_id);
      if (!customer) return { error: `Customer not found: ${args.customer_id}` };
      return customer;
    },

    get_order_details: (db, args: { order_id: string }) => {
      const order = db.orders.find((o: any) => o.order_id === args.order_id);
      if (!order) return { error: `Order not found: ${args.order_id}` };
      return order;
    },

    list_customer_orders: (db, args: { customer_id: string }) => {
      const orders = db.orders.filter((o: any) => o.customer_id === args.customer_id);
      return { orders };
    },

    get_product_details: (db, args: { product_id: string }) => {
      const product = db.products.find((p: any) => p.product_id === args.product_id);
      if (!product) return { error: `Product not found: ${args.product_id}` };
      return product;
    },

    search_products: (db, args: { query: string }) => {
      const q = args.query.toLowerCase();
      const results = db.products.filter(
        (p: any) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
      );
      return { products: results };
    },

    process_return: (db, args: { order_id: string }) => {
      const order = db.orders.find((o: any) => o.order_id === args.order_id);
      if (!order) return { error: `Order not found: ${args.order_id}` };
      if (order.status !== 'delivered') {
        return { error: `Order ${args.order_id} is not in delivered status (current: ${order.status})` };
      }

      // Check 30-day return window
      if (order.delivery_date) {
        const deliveryDate = new Date(order.delivery_date);
        const now = new Date();
        const daysSinceDelivery = Math.floor(
          (now.getTime() - deliveryDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (daysSinceDelivery > 30) {
          return {
            error: `Return window expired. Order was delivered ${daysSinceDelivery} days ago (30-day limit).`,
          };
        }
      }

      // Restock items
      for (const item of order.items) {
        const product = db.products.find((p: any) => p.product_id === item.product_id);
        if (product) product.stock += item.quantity;
      }

      order.status = 'returned';
      return { success: true, order: { ...order } };
    },

    process_exchange: (
      db,
      args: { order_id: string; old_product_id: string; new_product_id: string },
    ) => {
      const order = db.orders.find((o: any) => o.order_id === args.order_id);
      if (!order) return { error: `Order not found: ${args.order_id}` };
      if (order.status !== 'delivered') {
        return { error: `Order ${args.order_id} is not in delivered status` };
      }

      // Check 30-day exchange window
      if (order.delivery_date) {
        const deliveryDate = new Date(order.delivery_date);
        const now = new Date();
        const daysSinceDelivery = Math.floor(
          (now.getTime() - deliveryDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (daysSinceDelivery > 30) {
          return {
            error: `Exchange window expired. Order was delivered ${daysSinceDelivery} days ago (30-day limit).`,
          };
        }
      }

      // Find old item in order
      const oldItemIndex = order.items.findIndex(
        (i: any) => i.product_id === args.old_product_id,
      );
      if (oldItemIndex === -1) {
        return { error: `Product ${args.old_product_id} not found in order ${args.order_id}` };
      }

      // Find new product
      const newProduct = db.products.find((p: any) => p.product_id === args.new_product_id);
      if (!newProduct) return { error: `Product not found: ${args.new_product_id}` };
      if (newProduct.stock <= 0) {
        return { error: `Product ${args.new_product_id} (${newProduct.name}) is out of stock` };
      }

      const oldItem = order.items[oldItemIndex];

      // Restock old product
      const oldProduct = db.products.find((p: any) => p.product_id === args.old_product_id);
      if (oldProduct) oldProduct.stock += oldItem.quantity;

      // Deduct new product stock
      newProduct.stock -= oldItem.quantity;

      // Update order item
      order.items[oldItemIndex] = {
        product_id: newProduct.product_id,
        product_name: newProduct.name,
        quantity: oldItem.quantity,
        unit_price: newProduct.price,
      };

      // Recalculate total
      order.total = order.items.reduce(
        (sum: number, i: any) => sum + i.unit_price * i.quantity,
        0,
      );

      return {
        success: true,
        order: { ...order },
        price_difference: newProduct.price - oldItem.unit_price,
      };
    },

    update_order_status: (db, args: { order_id: string; new_status: string }) => {
      const order = db.orders.find((o: any) => o.order_id === args.order_id);
      if (!order) return { error: `Order not found: ${args.order_id}` };
      order.status = args.new_status;
      return { success: true, order: { ...order } };
    },
  };
}
