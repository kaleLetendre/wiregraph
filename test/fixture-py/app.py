# Python fixture: run() calls a method (cross-file, via attribute), a same-file
# function (helper), and a constructor (Service). Exercises method-kind tagging,
# attribute-call resolution, and a cross-file CALLS edge through a class method.

from svc import Service


def run(n):
    s = Service()
    return s.handle(n) + helper(n)


def helper(n):
    return n + 1
