import React from "react";
import {
  Bell,
  Lock,
  NavAddressBook,
  NavAutomations,
  NavBrowser,
  NavChevronRight,
  NavCipherMap,
  NavCircles,
  NavContracts,
  NavExpand,
  NavHistory,
  NavHome,
  NavNfts,
  NavPanel,
  NavPlus,
  NavPrivacy,
  NavReceive,
  NavSend,
  NavSettings,
  NavUpDown,
  NavWallets,
  Search,
  type CutIconType,
  type IconType,
} from "src/shared/ui/icons";

interface IconProps {
  size?: number;
  className?: string;
}

interface NavIconProps extends IconProps {
  live?: boolean;
}

const destination = (Glyph: CutIconType) =>
  function NavIcon({ size = 16, className, live }: NavIconProps): React.ReactElement {
    return <Glyph size={size} className={className} live={live} aria-hidden="true" />;
  };

const control = (Glyph: IconType) =>
  function ControlIcon({ size = 16, className }: IconProps): React.ReactElement {
    return <Glyph size={size} className={className} aria-hidden="true" />;
  };

export const HomeIcon = destination(NavHome);
export const SendIcon = destination(NavSend);
export const PrivacyIcon = destination(NavPrivacy);
export const HistoryIcon = destination(NavHistory);
export const ReceiveIcon = destination(NavReceive);
export const NftsIcon = destination(NavNfts);
export const ContractsIcon = destination(NavContracts);
export const WalletsIcon = destination(NavWallets);
export const AddressBookIcon = destination(NavAddressBook);
export const DappsIcon = destination(NavBrowser);
export const CirclesIcon = destination(NavCircles);
export const CipherMapIcon = destination(NavCipherMap);
export const AutomationsIcon = destination(NavAutomations);
export const SettingsIcon = destination(NavSettings);

export const ExpandIcon = control(NavExpand);
export const PanelIcon = control(NavPanel);
export const ChevronRightIcon = control(NavChevronRight);
export const PlusIcon = control(NavPlus);
export const UpDownIcon = control(NavUpDown);
export const SearchIcon = control(Search);
export const BellIcon = control(Bell);
export const LockIcon = control(Lock);
