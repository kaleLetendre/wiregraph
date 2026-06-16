// run() calls a method on another class (cross-file, via navigation_expression),
// a same-file top-level function (helper), and a constructor (Service()).
// Exercises method/function/class kinds and a cross-file CALLS edge.
package demo

fun helper(n: Int): Int = n + 1

fun run(n: Int): Int {
    val s = Service()
    return s.handle(n) + helper(n)
}
