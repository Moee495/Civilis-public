// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./interfaces/IACPV2ReadView.sol";

/// @title CivilisCommerceV2
/// @notice Civilis-specific domain mapping layer for ACPV2 jobs.
/// @dev This contract does not custody funds, mirror escrow balances, or
///      duplicate ACPV2 lifecycle state. It only maps Civilis business
///      references to ACPV2 job identifiers.
contract CivilisCommerceV2 is AccessControl {
    bytes32 public constant MAPPER_ROLE = keccak256("MAPPER_ROLE");

    enum BusinessType {
        Arena,
        Intel,
        Divination,
        Prediction
    }

    enum MappingStatus {
        Linked,
        Closed
    }

    struct BusinessLink {
        bytes32 businessRef;
        uint256 jobId;
        BusinessType businessType;
        bytes32 businessSubtype;
        MappingStatus status;
        bytes32 statusInfo;
        address mappedBy;
        uint256 mappedAt;
        uint256 updatedAt;
    }

    IACPV2ReadView public immutable acpKernel;

    mapping(bytes32 => BusinessLink) private linksByRef;
    mapping(uint256 => bytes32) private refsByJob;

    event BusinessMapped(
        bytes32 indexed businessRef,
        uint256 indexed jobId,
        BusinessType indexed businessType,
        bytes32 businessSubtype,
        MappingStatus status,
        address mappedBy
    );

    event MappingStatusUpdated(
        bytes32 indexed businessRef,
        uint256 indexed jobId,
        MappingStatus previousStatus,
        MappingStatus newStatus,
        bytes32 statusInfo,
        address updatedBy
    );

    constructor(address acpKernel_) {
        require(acpKernel_ != address(0), "Invalid ACP kernel");
        acpKernel = IACPV2ReadView(acpKernel_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MAPPER_ROLE, msg.sender);
    }

    function mapBusiness(
        bytes32 businessRef,
        BusinessType businessType,
        bytes32 businessSubtype,
        uint256 jobId
    ) external onlyRole(MAPPER_ROLE) {
        require(businessRef != bytes32(0), "Invalid business ref");
        require(linksByRef[businessRef].businessRef == bytes32(0), "Business ref already mapped");
        require(refsByJob[jobId] == bytes32(0), "ACP job already mapped");
        require(jobId < acpKernel.getJobCount(), "Invalid ACP job");

        BusinessLink memory link = BusinessLink({
            businessRef: businessRef,
            jobId: jobId,
            businessType: businessType,
            businessSubtype: businessSubtype,
            status: MappingStatus.Linked,
            statusInfo: bytes32(0),
            mappedBy: msg.sender,
            mappedAt: block.timestamp,
            updatedAt: block.timestamp
        });

        linksByRef[businessRef] = link;
        refsByJob[jobId] = businessRef;

        emit BusinessMapped(
            businessRef,
            jobId,
            businessType,
            businessSubtype,
            MappingStatus.Linked,
            msg.sender
        );
    }

    function closeMapping(
        bytes32 businessRef,
        bytes32 statusInfo
    ) external onlyRole(MAPPER_ROLE) {
        BusinessLink storage link = linksByRef[businessRef];
        require(link.businessRef != bytes32(0), "Unknown business ref");
        require(link.status == MappingStatus.Linked, "Link not active");

        MappingStatus previousStatus = link.status;
        link.status = MappingStatus.Closed;
        link.statusInfo = statusInfo;
        link.updatedAt = block.timestamp;

        emit MappingStatusUpdated(
            businessRef,
            link.jobId,
            previousStatus,
            MappingStatus.Closed,
            statusInfo,
            msg.sender
        );
    }

    function getBusinessLink(bytes32 businessRef) external view returns (BusinessLink memory) {
        BusinessLink memory link = linksByRef[businessRef];
        require(link.businessRef != bytes32(0), "Unknown business ref");
        return link;
    }

    function getBusinessRefForJob(uint256 jobId) external view returns (bytes32) {
        return refsByJob[jobId];
    }
}
