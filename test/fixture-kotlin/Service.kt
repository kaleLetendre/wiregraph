// Cross-file callee. Service.handle (a method) calls util (a top-level function
// in the same file) — the leaf the trace should reach from run().
package demo

fun util(x: Int): Int = x * 2

class Service {
    fun handle(n: Int): Int {
        return util(n)
    }
}
