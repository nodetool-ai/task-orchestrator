# Nested worker dispatch

Runs created inside an isolated worker are parked for the control plane to
dispatch. The worker has no database or infrastructure credentials. The
control plane later provisions the child through the selected `local` or
`sprites` runner provider.
