-- ============================================================
-- RC ESPETINHO CENTRAL
-- BANCO DE DADOS PRINCIPAL
-- ============================================================

-- ============================================================
-- USUÁRIOS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,

    role TEXT NOT NULL
        CHECK (role IN ('ADMIN', 'CAIXA', 'GARCOM')),

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- CATEGORIAS
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY,

    name TEXT UNIQUE NOT NULL,

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- PRODUTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY,

    category_id UUID
        REFERENCES categories(id)
        ON DELETE SET NULL,

    name TEXT NOT NULL,

    description TEXT,

    price NUMERIC(12,2) NOT NULL
        CHECK (price >= 0),

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- MESAS
-- ============================================================

CREATE TABLE IF NOT EXISTS dining_tables (
    id UUID PRIMARY KEY,

    number INTEGER UNIQUE NOT NULL
        CHECK (number > 0),

    status TEXT NOT NULL DEFAULT 'LIVRE'
        CHECK (
            status IN (
                'LIVRE',
                'OCUPADA',
                'AGUARDANDO_PAGAMENTO',
                'FECHADA'
            )
        ),

    active BOOLEAN NOT NULL DEFAULT TRUE
);


-- ============================================================
-- COMANDAS / PEDIDOS
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,

    table_id UUID NOT NULL
        REFERENCES dining_tables(id)
        ON DELETE RESTRICT,

    waiter_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    status TEXT NOT NULL DEFAULT 'ABERTO'
        CHECK (
            status IN (
                'ABERTO',
                'FECHADO',
                'CANCELADO'
            )
        ),

    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    closed_at TIMESTAMPTZ,

    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (subtotal >= 0),

    discount NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (discount >= 0),

    additions NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (additions >= 0),

    service_fee NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (service_fee >= 0),

    total NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (total >= 0)
);


-- ============================================================
-- ITENS DAS COMANDAS
-- ============================================================

CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY,

    order_id UUID NOT NULL
        REFERENCES orders(id)
        ON DELETE RESTRICT,

    product_id UUID
        REFERENCES products(id)
        ON DELETE SET NULL,

    product_name TEXT NOT NULL,

    unit_price NUMERIC(12,2) NOT NULL
        CHECK (unit_price >= 0),

    quantity NUMERIC(12,3) NOT NULL
        CHECK (quantity > 0),

    status TEXT NOT NULL DEFAULT 'ATIVO'
        CHECK (
            status IN (
                'ATIVO',
                'CANCELADO'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- PAGAMENTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY,

    order_id UUID NOT NULL
        REFERENCES orders(id)
        ON DELETE RESTRICT,

    method TEXT NOT NULL,

    amount NUMERIC(12,2) NOT NULL
        CHECK (amount > 0),

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- LOG DE AUDITORIA
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,

    actor_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    action TEXT NOT NULL,

    entity TEXT NOT NULL,

    entity_id UUID,

    table_number INTEGER,

    before_data JSONB,

    after_data JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- SESSÕES DO CAIXA
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_sessions (
    id UUID PRIMARY KEY,

    opened_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    closed_by UUID
        REFERENCES users(id)
        ON DELETE RESTRICT,

    closed_at TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'ABERTO'
        CHECK (
            status IN (
                'ABERTO',
                'FECHADO'
            )
        )
);


-- ============================================================
-- FECHAMENTOS DO CAIXA
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_closures (
    id UUID PRIMARY KEY,

    session_id UUID NOT NULL
        REFERENCES cash_sessions(id)
        ON DELETE RESTRICT,

    report JSONB NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- ÍNDICES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_orders_table_status
    ON orders(table_id, status);

CREATE INDEX IF NOT EXISTS idx_orders_waiter_status
    ON orders(waiter_id, status);

CREATE INDEX IF NOT EXISTS idx_orders_closed_at
    ON orders(closed_at);

CREATE INDEX IF NOT EXISTS idx_order_items_order
    ON order_items(order_id);

CREATE INDEX IF NOT EXISTS idx_payments_order
    ON payments(order_id);

CREATE INDEX IF NOT EXISTS idx_payments_created_at
    ON payments(created_at);

CREATE INDEX IF NOT EXISTS idx_audit_created
    ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_role_active
    ON users(role, active);

CREATE INDEX IF NOT EXISTS idx_products_category_active
    ON products(category_id, active);


-- ============================================================
-- GARANTIA:
-- UMA ÚNICA COMANDA ABERTA POR MESA
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_one_open_per_table
    ON orders(table_id)
    WHERE status = 'ABERTO';


-- ============================================================
-- GARANTIA:
-- APENAS UM CAIXA ABERTO POR VEZ
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS ux_one_open_cash_session
    ON cash_sessions(status)
    WHERE status = 'ABERTO';
