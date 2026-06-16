# Cross-file callee module. Service.handle (a method) calls util (a module-level
# function in this same file) — the leaf the trace should reach from run().

def util(x):
    return x * 2


class Service:
    @staticmethod
    def make():
        return Service()

    def handle(self, n):
        return util(n)
