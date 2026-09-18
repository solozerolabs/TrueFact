# TrueFact README demo — render with:  brew install vhs && vhs demo/demo.tape
# Produces demo/truefact.gif. Runs the real CLI against a real recorded run
# (demo/checkout.jsonl): the agent claimed the order was placed; the server 500'd.
Output demo/truefact.gif
Set Shell "bash"
Set FontSize 20
Set Width 1100
Set Height 620
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# make `truefact` resolve to the committed dist (no install needed for the render)
Hide
Type "alias truefact='node dist/cli.js'" Enter
Ctrl+L
Show

Sleep 600ms
Type "# the agent said it placed the order. did it? ask the world, not the agent." Enter
Sleep 1s

Type "truefact assert demo/checkout.jsonl --with demo/assertions.mjs" Sleep 500ms Enter
Sleep 3s

Type "echo exit=$?   # non-zero: CI fails on the lie the agent told" Sleep 400ms Enter
Sleep 3s
