Linux Systemd Auto-Start
This repository includes a systemd unit template to auto-start the Eyeingggg monitor.

- Path notes:
  The monitor script is monitor.py. If you installed it in a different path, update ExecStart accordingly.
- How to enable:
  1) Copy the template to the systemd directory and adjust placeholders
     sudo cp linux/eyeingggg.service.template /etc/systemd/system/eyeingggg.service
     sudo sed -i 's|/home/YOUR_USER/eyeingggg|/path/to/eyeingggg|g' /etc/systemd/system/eyeingggg.service
     sudo sed -i 's/YOUR_USER/eyeingggg/eyeingggg/g' /etc/systemd/system/eyeingggg.service
  2) Reload systemd, enable and start:
     sudo systemctl daemon-reload
     sudo systemctl enable eyeingggg
     sudo systemctl start eyeingggg
  3) Check status and logs:
     sudo systemctl status eyeingggg
     sudo journalctl -u eyeingggg -n 50 -f

Notes:
- The unit runs the monitor in headless, silent mode by default.
- Requires Python 3.8+ and a Python virtual environment or system Python with dependencies installed (see requirements.txt).
- If the path contains spaces or special characters, escape accordingly.
