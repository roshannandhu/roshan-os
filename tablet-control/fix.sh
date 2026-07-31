#!/system/bin/sh
sed -i 's/no_install_apps="true"/no_install_apps="false"/g' /data/system/device_policies.xml
sed -i 's/no_uninstall_apps="true"/no_uninstall_apps="false"/g' /data/system/device_policies.xml
sync
reboot
