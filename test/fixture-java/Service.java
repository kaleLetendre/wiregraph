// Cross-file callee. Service.handle (a method) calls util (a method in the same
// class/file) — the leaf the trace should reach from App.run().
package demo;

class Service {
    int util(int x) {
        return x * 2;
    }

    int handle(int n) {
        return util(n);
    }
}
