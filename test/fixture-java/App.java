// run() calls a method on another class (cross-file, via method_invocation), a
// same-file static method (helper), and a constructor (new Service()). Exercises
// method/constructor/class kinds and a cross-file CALLS edge through a method.
package demo;

public class App {
    static int helper(int n) {
        return n + 1;
    }

    public static int run(int n) {
        Service s = new Service();
        return s.handle(n) + helper(n);
    }
}
