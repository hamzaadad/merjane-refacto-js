/* eslint-disable @typescript-eslint/switch-exhaustiveness-check */
/* eslint-disable max-depth */
/* eslint-disable no-await-in-loop */
import {eq} from 'drizzle-orm';
import fastifyPlugin from 'fastify-plugin';
import {serializerCompiler, validatorCompiler, type ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {orders, products} from '@/db/schema.js';
import { FastifyInstance } from 'fastify';

const orderSchema = {
	schema: {
		params: z.object({
			orderId: z.coerce.number(),
		}),
	},
} 
async function updateAvailability(
  product: any,
  products: any,
  dbTransaction: any
): Promise<void> {
  product.available -= 1;
  await dbTransaction.update(products).set(product).where(eq(products.id, product.id));
}

function isDateInRange(date: Date, start: Date, end: Date, current: Date): boolean {
  return current > start && current < end;
}
async function handleProductByType(
  product: any,
  currentDate: Date,
  dbTransaction: any,
  notificationService: any
): Promise<void> {
  const handlers: Record<string, () => Promise<void>> = {
    NORMAL: async () => {
      if (product.available > 0) {
        await updateAvailability(product, products, dbTransaction);
      } else if (product.leadTime > 0) {
        await notificationService.notifyDelay(product.leadTime, product);
      }
    },

    SEASONAL: async () => {
      if (
        product.seasonStartDate instanceof Date &&
        product.seasonEndDate instanceof Date &&
        isDateInRange(product.seasonStartDate, product.seasonStartDate, product.seasonEndDate, currentDate) &&
        product.available > 0
      ) {
        await updateAvailability(product, products, dbTransaction);
      } else {
        await notificationService.handleSeasonalProduct(product);
      }
    },

    EXPIRABLE: async () => {
      if (
        product.expiryDate instanceof Date &&
        product.available > 0 &&
        product.expiryDate > currentDate
      ) {
        await updateAvailability(product, products, dbTransaction);
      } else {
        await notificationService.handleExpiredProduct(product);
      }
    },
  };
  
  const handler = handlers[product.type];
  if (handler) {
    await handler();
  } else {
    throw new Error(`Unsupported product type: ${product.type}`);
  }
}
async function handleProcessOrder(request, reply, server: FastifyInstance) {
  const db = server.diContainer.resolve('db');
  const notificationService = server.diContainer.resolve('ps');
  
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, request.params.orderId),
    with: {
      products: {
        columns: {},
        with: {
          product: true,
        },
      },
    },
  });
  console.log(JSON.stringify(order));
  
  if (!order) {
    return reply.status(404).send({ error: 'Order not found' });
  }

  const productList = order.products || [];
  const currentDate = new Date();

  await db.transaction(async (tx) => {
    for (const productEntry of productList) {
      await handleProductByType(
        productEntry.product,
        currentDate,
        tx,
        notificationService
      );
    }
  });

  await reply.send({ orderId: order.id });
}

export const myController = fastifyPlugin(async (server) => {
	// Add schema validator and serializer
	server.setValidatorCompiler(validatorCompiler);
	server.setSerializerCompiler(serializerCompiler);

	server.withTypeProvider<ZodTypeProvider>().post('/orders/:orderId/processOrder', orderSchema, async (request: any, reply: any) => handleProcessOrder(request, reply, server));
});

