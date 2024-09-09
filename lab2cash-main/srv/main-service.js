const cds = require('@sap/cds');

module.exports = (async (srv) => {

    const db = await cds.connect.to('db');
    const dbe = db.entities;

    const proxyS4 = await cds.connect.to('LAB2CASH_PROXY');
    const s4e = proxyS4.entities;
    
    srv.before('CREATE', 'A_SalesOrder', async (req) => {
        const { PurchaseOrderByCustomer, TotalNetAmount, Order } = req.data;

        const parameters = await SELECT.one().from(dbe.Parameters);

        // 1 - Está usando cashback? O cashback está ativado?
        if (Order.applied_cashback > 0 && !parameters.is_cashback_active) {
            return req.error(422, 'Cashback is not active.');
        }

        // 2 - Business Partner existe no S/4?
        const bp = await proxyS4.run(
            SELECT.one(s4e.A_BusinessPartner).where({ BusinessPartner: PurchaseOrderByCustomer })
        );


        if (!bp) {
            return req.error(404, 'Business Partner not found.');
        }

        // 3 - Customer existe no HANA?
        let customer = await SELECT.one().from(dbe.Customers).where({ business_partner_id: PurchaseOrderByCustomer });

        if (!customer) {
            const response = await INSERT.into(dbe.Customers).entries({
                business_partner_id: PurchaseOrderByCustomer,
                wallet: {
                    balance: 0
                }
            });

            console.log(`Customer created: ${response}`)
        }

        customer = await SELECT.one`from ${dbe.Customers} {
            *, wallet {
                *
            }
        } where business_partner_id = ${PurchaseOrderByCustomer}`;

        // 4 - Está usando cashback? Tem saldo em carteira?
        if (Order.applied_cashback > customer.wallet.balance) {
            return req.error(422, 'Applied cashback is greater than customer wallet balance.');
        }

        // 5 - Está usando cashback? O cashback excede o limite de resgate?
        const allowedRedemptionLimit = TotalNetAmount * parameters.cashback_redemption_limit;

        if (Order.applied_cashback > allowedRedemptionLimit) {
            return req.error(422, 'Cashback redemption limit exceed.');
        }
    });

    srv.on('CREATE', 'A_SalesOrder', async (req) => {
        // 1 - Fazer os selects
        const {
            SalesOrderType,
            PurchaseOrderByCustomer,
            SoldToParty,
            TotalNetAmount,
            to_Item,
            Order
        } = req.data;

        const customer = await SELECT.one`from ${dbe.Customers} {
            *, wallet {
                *
            }
        } where business_partner_id = ${PurchaseOrderByCustomer}`;

        const orderAmountInCents = (TotalNetAmount * 100) - Order.applied_cashback;

        const parameters = await SELECT.one(dbe.Parameters);
        const receveidCashbackInCents = orderAmountInCents * (parameters.cashback_return / 100);

        // 2 - Criar a Sales Order no S/4
        const salesOrder = await proxyS4.run(
            INSERT({
                SalesOrderType,
                PurchaseOrderByCustomer,
                SoldToParty,
                TotalNetAmount,
                to_Item,
            }).into(s4e.A_SalesOrder)
        );

        // 3 - Criar as transactions
        const transactions = [];

        if (Order.applied_cashback > 0) {
            transactions.push({
                type: 'REDEMPTION',
                amount: Order.applied_cashback,
                wallet: {
                    ID: customer.wallet.ID
                }
            });
        }

        if (receveidCashbackInCents > 0) {
            transactions.push({
                type: 'CREDIT',
                amount: receveidCashbackInCents,
                wallet: {
                    ID: customer.wallet.ID
                }
            });
        }

        console.log(JSON.stringify(transactions));
 
        // 4 - Criar a order (CAP)
        const orderRes = await INSERT({
            sales_order_id: salesOrder.SalesOrder,
            applied_cashback: Order.applied_cashback,
            amount: orderAmountInCents,
            customer_ID: customer.ID,
            transactions
        }).into(dbe.Orders);


        console.log(`Order created: ${orderRes}`);

        // 5 - Atualizar saldo da carteira
        const transactionsAmount = transactions.reduce((accumulator, current) => {
            const value = current.type === 'REDEMPTION'
                ? accumulator - current.amount
                : accumulator + current.amount

            return value
        }, 0);

        const updatedBalance = customer.wallet.balance + transactionsAmount;

        await UPDATE(dbe.Wallets)
            .set({ balance: updatedBalance })
            .where({ ID: customer.wallet.ID });

        console.log(`Balance updated: $ ${(updatedBalance / 100).toFixed(2)}`);
        await srv.emit('balanceUpdated', { wallet_ID: customer.wallet.ID });

        return salesOrder;
    });

    srv.on('READ', 'A_BusinessPartner', (req) => proxyS4.run(req.query));

    srv.on('READ', 'A_SalesOrder', (req) => proxyS4.get(req.http.req.url));

    srv.on('READ', 'A_Product', (req) => proxyS4.get(req.http.req.url));

    srv.on('balanceUpdated', async (req) => {
        const { wallet_ID } = req.data;

        const wallet = await SELECT.one(dbe.Wallets).where({ ID: wallet_ID });

        console.log({ wallet });
    })

    srv.on('getParameters', async (req) => {
        const parameters = await SELECT.one().from(dbe.Parameters);

        return parameters;
    });

    srv.on('updateParameters', async (req) => {
        const { parameters } = req.data;
        
        await UPDATE(dbe.Parameters).set(parameters);

        return parameters
    });

});