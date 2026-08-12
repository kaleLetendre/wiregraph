// Cross-file callee. Service is a struct (kind 'class'); new() and handle() are
// function_items inside an `impl` block, so both are methods; util() is a free
// function_item at file scope, so it is a function. handle() calls util(), which is the
// leaf the trace reaches from run() in app.rs.

pub struct Service {
    n: i32,
}

pub fn util(x: i32) -> i32 {
    x * 2
}

impl Service {
    pub fn new() -> Self {
        Service { n: 0 }
    }

    pub fn handle(&self, n: i32) -> i32 {
        util(n + self.n)
    }
}

// A trait impl is the same `impl_item` shape with an extra `trait:` field, so its methods
// must be tagged 'method' too — and a trait's DEFAULT body is a method as well, while its
// bodiless signature is not a symbol at all.
pub trait Runner {
    fn go(&self) -> i32;

    fn twice(&self) -> i32 {
        self.go() * 2
    }
}

impl Runner for Service {
    fn go(&self) -> i32 {
        self.handle(1)
    }
}
